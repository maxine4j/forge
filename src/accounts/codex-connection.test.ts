import { sleep } from "@forge/backend-infrastructure/sleep";
import { describe, expect, it, vi } from "vitest";

import type { IAccountProcess } from "./account-process.ts";
import { CodexConnection } from "./codex-connection.ts";
import type { AccountProcessSpec } from "./types.ts";

describe("CodexConnection", () => {
	it.each([false, true])(
		"accepts large history frames and completion notifications (chunked: %s), but rejects over 16 MiB",
		async (chunked) => {
			let output: (chunk: string) => void = () => {};
			const stop = vi.fn(async () => {});
			const text = "x".repeat(2 * 1024 * 1024);
			const emit = (message: unknown) => {
				const frame = JSON.stringify(message) + "\n";
				if (chunked) {
					for (let offset = 0; offset < frame.length; offset += 65536)
						output(frame.slice(offset, offset + 65536));
				} else output(frame);
			};
			const connection = new CodexConnection(
				{
					initialize: async () => {},
					spawn: (spec) => {
						output = spec.onOutput;
						return {
							done: new Promise(() => {}),
							stop,
							write: (data) => {
								const message = JSON.parse(data);
								if (message.method === "initialize")
									emit({
										id: message.id,
										result: {
											userAgent: "test",
											codexHome: "/data/codex",
											platformFamily: "unix",
											platformOs: "linux",
										},
									});
								if (message.method === "thread/items/list") {
									emit({ method: "turn/completed", params: { text } });
									emit({ id: message.id, result: { data: [{ text }], nextCursor: null } });
								}
								if (message.method === "account/rateLimits/read" && message.params === null)
									emit({ id: message.id, result: { rateLimits: {} } });
							},
						};
					},
				},
				sleep,
			);
			const notifications = vi.fn();
			connection.subscribe(notifications);
			try {
				await connection.initialize();
				await expect(
					connection.request("thread/items/list", { threadId: "thread", limit: 20, sortDirection: "desc" }),
				).resolves.toMatchObject({ data: [{ text }] });
				expect(notifications).toHaveBeenCalledWith("turn/completed", { text });
				expect(stop).not.toHaveBeenCalled();
				await expect(connection.request("account/rateLimits/read", null)).resolves.toEqual({ rateLimits: {} });
				const pending = connection.request("account/read", {});
				await Promise.resolve();
				output("x".repeat(16 * 1024 * 1024 + 1));
				await expect(pending).rejects.toThrow("Codex connection unavailable");
				expect(stop).toHaveBeenCalledOnce();
			} finally {
				await connection.close();
			}
		},
	);
	it("normal shutdown stops the child without reporting connection failure", async () => {
		const warn = vi.fn();
		const notifications = vi.fn();
		const stop = vi.fn(async () => {});
		let output: (chunk: string) => void = () => {};
		let initialized = false;
		const processes: IAccountProcess = {
			initialize: async () => {
				initialized = true;
			},
			spawn: (spec) => {
				output = spec.onOutput;
				return {
					done: new Promise(() => {}),
					stop,
					write: (data) => {
						const message = JSON.parse(data);
						if (message.method === "initialize")
							output(
								JSON.stringify({
									id: message.id,
									result: {
										userAgent: "codex/0.164.0",
										codexHome: "/data/codex",
										platformFamily: "unix",
										platformOs: "linux",
									},
								}) + "\n",
							);
					},
				};
			},
		};
		const connection = new CodexConnection(processes, sleep, 100, { warn, error: vi.fn() });
		connection.subscribe(notifications);
		await connection.initialize();
		expect(initialized).toBe(true);
		await connection.close();
		expect(stop).toHaveBeenCalledOnce();
		expect(warn).not.toHaveBeenCalled();
		expect(notifications).not.toHaveBeenCalled();
	});
	it("initializes once, correlates responses and rejects pending work on exit", async () => {
		let output: (chunk: string) => void = () => {};
		let exit: (code: number) => void = () => {};
		const sent: Record<string, unknown>[] = [];
		let starts = 0;
		const processes: IAccountProcess = {
			initialize: async () => {},
			spawn: (spec: AccountProcessSpec) => {
				starts++;
				output = spec.onOutput;
				return {
					done: new Promise((resolve) => {
						exit = resolve;
					}),
					stop: async () => {
						exit(0);
					},
					write: (data) => {
						const message: Record<string, unknown> = JSON.parse(data);
						sent.push(message);
						if (message["method"] === "initialize")
							output(
								JSON.stringify({
									id: message["id"],
									result: {
										userAgent: "codex/0.164.0",
										codexHome: "/data/codex",
										platformFamily: "unix",
										platformOs: "linux",
									},
								}) + "\n",
							);
					},
				};
			},
		};
		const connection = new CodexConnection(processes, sleep, 100);
		await Promise.all([connection.initialize(), connection.initialize()]);
		expect(starts).toBe(1);
		expect(sent.map((value) => value["method"])).toEqual(["initialize", "initialized"]);
		const pending = connection.request("account/read", { refreshToken: true });
		exit(1);
		await expect(pending).rejects.toThrow("Codex connection unavailable");
		await connection.close();
	});

	it("bounds frames and request deadlines, and rejects unsupported methods", async () => {
		let output: (chunk: string) => void = () => {};
		let stopped = false;
		let quotaId: number | undefined;
		const processes: IAccountProcess = {
			initialize: async () => {},
			spawn: (spec) => {
				output = spec.onOutput;
				return {
					done: new Promise(() => {}),
					stop: async () => {
						stopped = true;
					},
					write: (data) => {
						const message = JSON.parse(data);
						if (message.method === "account/rateLimits/read") quotaId = message.id;
						if (message.method === "initialize")
							output(
								JSON.stringify({
									id: message.id,
									result: {
										userAgent: "codex/0.164.0",
										codexHome: "/data/codex",
										platformFamily: "unix",
										platformOs: "linux",
									},
								}) + "\n",
							);
					},
				};
			},
		};
		const connection = new CodexConnection(processes, sleep, 10);
		await connection.initialize();
		await expect(connection.request("arbitrary/method", {})).rejects.toThrow("Unsupported Codex operation");
		await expect(connection.request("account/rateLimits/read", null)).rejects.toThrow(
			"Codex connection unavailable",
		);
		expect(stopped).toBe(false);
		output(JSON.stringify({ id: quotaId, result: { rateLimits: {} } }) + "\n");
		expect(stopped).toBe(false);
		await expect(connection.request("account/read", {})).rejects.toThrow("Codex connection unavailable");
		expect(stopped).toBe(true);
		await connection.initialize();
		const pending = connection.request("account/read", {});
		output("x".repeat(16 * 1024 * 1024 + 1));
		await expect(pending).rejects.toThrow("Codex connection unavailable");
		await connection.close();
	});
	it("routes execution requests and correlates one-time server replies", async () => {
		let output: (chunk: string) => void = () => {};
		const writes: Record<string, unknown>[] = [];
		const connection = new CodexConnection(
			{
				initialize: async () => {},
				spawn: (spec) => {
					output = spec.onOutput;
					return {
						done: new Promise(() => {}),
						stop: async () => {},
						write: (data) => {
							const message = JSON.parse(data);
							writes.push(message);
							if (message.method === "initialize")
								output(
									JSON.stringify({
										id: message.id,
										result: {
											userAgent: "test",
											codexHome: "/data/codex",
											platformFamily: "unix",
											platformOs: "linux",
										},
									}) + "\n",
								);
							if (["thread/read", "thread/start", "thread/resume"].includes(message.method))
								output(JSON.stringify({ id: message.id, result: { thread: { id: "thread" } } }) + "\n");
						},
					};
				},
			},
			sleep,
		);
		const request = vi.fn(() => true);
		connection.subscribeRequests(request);
		await connection.initialize();
		const options = {
			cwd: "/data/worktrees/one",
			sandbox: "danger-full-access",
			approvalPolicy: "on-request",
			config: { features: { multi_agent: false } },
		};
		for (const method of ["thread/start", "thread/resume"]) {
			const params = method === "thread/start" ? options : { ...options, threadId: "thread", excludeTurns: true };
			expect(await connection.request(method, params)).toEqual({ thread: { id: "thread" } });
			expect(writes.at(-1)).toMatchObject({ method, params });
			await expect(connection.request(method, { ...params, sandbox: "workspace-write" })).rejects.toThrow(
				"Invalid Codex operation input",
			);
		}
		expect(await connection.request("thread/read", { threadId: "thread", includeTurns: true })).toEqual({
			thread: { id: "thread" },
		});
		output(
			JSON.stringify({
				id: "approval",
				method: "item/commandExecution/requestApproval",
				params: { threadId: "thread" },
			}) + "\n",
		);
		expect(request).toHaveBeenCalledWith("approval", "item/commandExecution/requestApproval", {
			threadId: "thread",
		});
		connection.respond("approval", { decision: "decline" });
		expect(writes.at(-1)).toEqual({ id: "approval", result: { decision: "decline" } });
		expect(() => connection.respond("approval", { decision: "accept" })).toThrow();
		output(
			JSON.stringify({
				id: "cancelled",
				method: "item/fileChange/requestApproval",
				params: { threadId: "thread" },
			}) + "\n",
		);
		output(
			JSON.stringify({ method: "serverRequest/resolved", params: { threadId: "thread", requestId: "cancelled" } })
				+ "\n",
		);
		expect(() => connection.respond("cancelled", { decision: "accept" })).toThrow();
		await connection.close();
	});
});
