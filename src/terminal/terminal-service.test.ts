import type { TerminalSession, TerminalServerMessage } from "@forge/contracts/terminal";
import { describe, expect, it, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import type { IWorkspaceService } from "../workspaces/workspace-service.ts";
import type { ITerminalProcess } from "./terminal-process.ts";
import { TerminalService } from "./terminal-service.ts";
import type { ITerminalStore } from "./terminal-store.ts";
import type { TerminalProcessSpec } from "./types.ts";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const actor = { username: "owner" };
const fixture = () => {
	const records = new Map<string, TerminalSession>();
	const store: ITerminalStore = {
		insert: async (record) => {
			records.set(record.id, { ...record });
		},
		update: async (record) => {
			records.set(record.id, { ...record });
		},
		get: async (key) => records.get(key),
		latest: async (key) => [...records.values()].filter((r) => r.workspaceId === key).at(-1),
		loseActive: async (endedAt) => {
			for (const record of records.values())
				if (["starting", "running"].includes(record.status))
					records.set(record.id, { ...record, status: "lost", endedAt });
		},
	};
	let finish!: (code: number) => void;
	const done = new Promise<number>((resolve) => {
		finish = resolve;
	});
	let spec!: TerminalProcessSpec;
	let expire: () => void = () => {};
	let nextId = 0;
	const handle = {
		done,
		write: vi.fn(),
		resize: vi.fn(),
		stop: vi.fn(async () => {
			finish(0);
		}),
	};
	const process: ITerminalProcess = {
		spawn: vi.fn(async (input) => {
			spec = input;
			return handle;
		}),
	};
	const resolve = vi.fn(async () => ({ path: "/verified", workspace: { id: workspaceId } }));
	const workspaces = { resolve } as unknown as IWorkspaceService;
	const service = new TerminalService(
		store,
		process,
		workspaces,
		new AccessService({ owner: "owner", origin: "https://forge.example" }),
		() => (nextId++ === 0 ? id : `bbbbbbbb-bbbb-4bbb-8bbb-${String(nextId).padStart(12, "0")}`),
		() => new Date("2026-01-01T00:00:00Z"),
		(_ms, signal) =>
			new Promise((resolve, reject) => {
				expire = resolve;
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			}),
	);
	return {
		service,
		records,
		handle,
		process,
		resolve,
		output: (data: string) => spec.onOutput(data),
		finish,
		expire: () => expire(),
	};
};

describe("TerminalService", () => {
	it("creates one explicit shell in the verified workspace; reconnect retains it and input/resize target it", async () => {
		const f = fixture();
		const session = await f.service.create(actor, workspaceId, { cols: 80, rows: 24 });
		expect(session.status).toBe("running");
		expect(f.process.spawn).toHaveBeenCalledWith(expect.objectContaining({ path: "/verified" }));
		await expect(f.service.create(actor, workspaceId, { cols: 80, rows: 24 })).rejects.toMatchObject({
			code: "terminal-conflict",
		});
		const messages: TerminalServerMessage[] = [];
		const first = await f.service.attach(actor, id, 0, (message) => messages.push(message));
		first.detach();
		f.output("still here");
		const second = await f.service.attach(actor, id, 0, (message) => messages.push(message));
		expect(messages).toContainEqual({ type: "output", sequence: 1, data: "still here" });
		expect(f.process.spawn).toHaveBeenCalledTimes(1);
		await f.service.input(actor, id, { type: "input", data: "pwd\r" });
		await f.service.input(actor, id, { type: "resize", cols: 120, rows: 40 });
		expect(f.handle.write).toHaveBeenCalledWith("pwd\r");
		expect(f.handle.resize).toHaveBeenCalledWith(120, 40);
		second.detach();
		await f.service.shutdown();
		expect(f.handle.stop).toHaveBeenCalledTimes(1);
		expect(f.records.get(id)?.status).toBe("closed");
	});
	it("denies nonowners, rejects invalid dimensions and never creates during attach", async () => {
		const f = fixture();
		await expect(f.service.create({ username: "other" }, workspaceId, { cols: 80, rows: 24 })).rejects.toThrow(
			"Access denied",
		);
		await expect(f.service.create(actor, workspaceId, { cols: 0, rows: 24 })).rejects.toMatchObject({
			code: "invalid-request",
		});
		await expect(f.service.attach(actor, id, 0, () => {})).rejects.toMatchObject({ code: "terminal-not-found" });
		expect(f.process.spawn).not.toHaveBeenCalled();
	});
	it("bounds replay, reports a gap, and records exit without restarting", async () => {
		const f = fixture();
		await f.service.create(actor, workspaceId, { cols: 80, rows: 24 });
		for (let i = 0; i < 40; i++) f.output("x".repeat(16384));
		const messages: TerminalServerMessage[] = [];
		await f.service.attach(actor, id, 0, (message) => messages.push(message));
		expect(messages.at(0)).toMatchObject({ type: "gap" });
		expect(
			messages
				.filter((m) => m.type === "output")
				.reduce((n, m) => n + (m.type === "output" ? Buffer.byteLength(m.data) : 0), 0),
		).toBeLessThanOrEqual(262144);
		f.finish(7);
		await vi.waitFor(() => expect(f.records.get(id)?.status).toBe("exited"));
		expect(f.records.get(id)?.exitCode).toBe(7);
		await f.service.shutdown();
	});
	it("marks durable active sessions lost on recovery without spawning", async () => {
		const f = fixture();
		f.records.set(id, {
			id,
			workspaceId,
			createdAt: "2026-01-01T00:00:00Z",
			status: "running",
			cols: 80,
			rows: 24,
		});
		await f.service.recover();
		expect(f.records.get(id)?.status).toBe("lost");
		expect(f.process.spawn).not.toHaveBeenCalled();
	});
	it("records failed spawn as lost and allows an explicit later creation", async () => {
		const f = fixture();
		vi.mocked(f.process.spawn).mockRejectedValueOnce(new Error("native unavailable"));
		await expect(f.service.create(actor, workspaceId, { cols: 80, rows: 24 })).rejects.toMatchObject({
			code: "terminal-unavailable",
		});
		expect(f.records.get(id)?.status).toBe("lost");
		const replacement = await f.service.create(actor, workspaceId, { cols: 80, rows: 24 });
		f.finish(3);
		await f.service.close(actor, replacement.id);
		expect(["exited", "closed"]).toContain(f.records.get(replacement.id)?.status);
		await f.service.shutdown();
		await expect(f.service.create(actor, workspaceId, { cols: 80, rows: 24 })).rejects.toMatchObject({
			code: "terminal-unavailable",
		});
	});
	it("bounds all accepted input over the session lifetime", async () => {
		const f = fixture();
		await f.service.create(actor, workspaceId, { cols: 80, rows: 24 });
		for (let i = 0; i < 64; i++) await f.service.input(actor, id, { type: "input", data: "x".repeat(16384) });
		await expect(f.service.input(actor, id, { type: "input", data: "x" })).rejects.toMatchObject({
			code: "terminal-capacity",
		});
		await f.service.shutdown();
	});
	it("bounds attaches, validates cursors, and preserves Unicode output", async () => {
		const f = fixture();
		await f.service.create(actor, workspaceId, { cols: 80, rows: 24 });
		await expect(f.service.attach(actor, id, Number.MAX_SAFE_INTEGER + 1, () => {})).rejects.toMatchObject({
			code: "invalid-request",
		});
		const messages: TerminalServerMessage[] = [];
		await f.service.attach(actor, id, 0, (message) => messages.push(message));
		for (let i = 0; i < 3; i++) await f.service.attach(actor, id, 0, () => {});
		await expect(f.service.attach(actor, id, 0, () => {})).rejects.toMatchObject({ code: "terminal-capacity" });
		const text = "🙂".repeat(5000);
		f.output(text);
		expect(
			messages
				.filter((m) => m.type === "output")
				.map((m) => (m.type === "output" ? m.data : ""))
				.join(""),
		).toBe(text);
		await f.service.shutdown();
	});
	it("closes on the injected maximum session duration and total output bound", async () => {
		const deadline = fixture();
		await deadline.service.create(actor, workspaceId, { cols: 80, rows: 24 });
		deadline.expire();
		await vi.waitFor(() => expect(deadline.records.get(id)?.status).toBe("closed"));
		await deadline.service.shutdown();
		const output = fixture();
		await output.service.create(actor, workspaceId, { cols: 80, rows: 24 });
		const chunk = "x".repeat(16384);
		for (let i = 0; i < 1025; i++) output.output(chunk);
		await vi.waitFor(() => expect(output.records.get(id)?.status).toBe("closed"));
		await output.service.shutdown();
	});
	it("caps concurrent live shells across workspaces", async () => {
		const f = fixture();
		for (let i = 0; i < 8; i++)
			await f.service.create(actor, `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`, {
				cols: 80,
				rows: 24,
			});
		await expect(f.service.create(actor, workspaceId, { cols: 80, rows: 24 })).rejects.toMatchObject({
			code: "terminal-capacity",
		});
		await f.service.shutdown();
	});
});
