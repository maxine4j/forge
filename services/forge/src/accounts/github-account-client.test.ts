import { sleep } from "@forge/backend-infrastructure/sleep";
import { describe, expect, it } from "vitest";

import type { IAccountProcess } from "./account-process.ts";
import { GithubAccountClient } from "./github-account-client.ts";

describe("GithubAccountClient", () => {
	it("maps a validated HTTP401 /user response to signed-out and rejects other failures", async () => {
		let status = 401;
		const client = new GithubAccountClient(
			{
				initialize: async () => {},
				spawn: (spec) => {
					expect(spec.arguments).toEqual(["api", "--include", "--hostname", "github.com", "user"]);
					spec.onOutput(
						`HTTP/2.0 ${status} Unauthorized\r\nContent-Type: application/json\r\n\r\n`
							+ JSON.stringify({ message: "Requires authentication", status: String(status) }),
					);
					return { done: Promise.resolve(1), stop: async () => {}, write: () => {} };
				},
			},
			sleep,
			{ pending: async () => false, save: async () => {} },
		);
		expect(await client.status()).toMatchObject({ connection: "available", login: { state: "idle" } });
		status = 403;
		expect((await client.status()).connection).toBe("unavailable");
	});
	it("retries credential-home initialization after permissions are repaired", async () => {
		let repaired = false;
		let initialized = false;
		const processes: IAccountProcess = {
			initialize: async () => {
				if (!repaired) throw new Error("permissions");
				initialized = true;
			},
			spawn: (spec) => {
				if (!initialized) throw new Error("not initialized");
				spec.onOutput("HTTP/2.0 200 OK\r\n\r\n" + JSON.stringify({ login: "owner" }));
				return { done: Promise.resolve(0), write: () => {}, stop: async () => {} };
			},
		};
		const client = new GithubAccountClient(processes, sleep, { pending: async () => false, save: async () => {} });
		expect((await client.status()).connection).toBe("unavailable");
		repaired = true;
		expect(await client.status()).toMatchObject({ connection: "available", account: { name: "owner" } });
	});
	it("permits explicit retry after a failed process even while verification is unavailable", async () => {
		let starts = 0;
		let finish: (code: number) => void = () => {};
		const processes: IAccountProcess = {
			initialize: async () => {},
			spawn: (spec) => {
				if (spec.arguments[0] === "api") throw new Error("network unavailable");
				starts++;
				queueMicrotask(() =>
					spec.onOutput(
						"First copy your one-time code: ABCD-EFGH\nOpen this URL to continue in your web browser: https://github.com/login/device\n",
					),
				);
				return {
					done: new Promise((resolve) => {
						finish = resolve;
					}),
					write: () => {},
					stop: async () => {
						finish(1);
					},
				};
			},
		};
		const client = new GithubAccountClient(processes, sleep, { pending: async () => false, save: async () => {} });
		await client.start();
		finish(1);
		await Promise.resolve();
		await client.start();
		expect(starts).toBe(2);
		await client.close();
	});
	it("extracts only the supported device URL/code and verifies the account after login exits", async () => {
		let complete: (code: number) => void = () => {};
		let verified = false;
		const processes: IAccountProcess = {
			initialize: async () => {},
			spawn: (spec) => {
				if (spec.arguments[0] === "api") {
					spec.onOutput("HTTP/2.0 200 OK\r\n\r\n" + JSON.stringify({ login: "owner", token: "SECRET" }));
					verified = true;
					return { done: Promise.resolve(0), write: () => {}, stop: async () => {} };
				}
				expect(spec.arguments).toEqual([
					"auth",
					"login",
					"--hostname",
					"github.com",
					"--git-protocol",
					"https",
					"--web",
					"--insecure-storage",
					"--scopes",
					"workflow",
				]);
				queueMicrotask(() =>
					spec.onOutput(
						"! First copy your one-time code: ABCD-EFGH\nOpen this URL to continue in your web browser: https://github.com/login/device\n",
					),
				);
				return {
					done: new Promise((resolve) => {
						complete = resolve;
					}),
					write: () => {},
					stop: async () => {
						complete(1);
					},
				};
			},
		};
		const client = new GithubAccountClient(processes, sleep, { pending: async () => false, save: async () => {} });
		expect(await client.start()).toMatchObject({ login: { state: "pending", userCode: "ABCD-EFGH" } });
		expect(verified).toBe(false);
		complete(0);
		expect(await client.status()).toMatchObject({ account: { name: "owner" }, login: { state: "completed" } });
		expect(JSON.stringify(await client.status())).not.toContain("SECRET");
		await client.close();
	});
	it("cancels and clears device codes without reporting success, and bounds a silent login", async () => {
		let stopped = 0;
		let pending = false;
		const processes: IAccountProcess = {
			initialize: async () => {},
			spawn: () => ({
				done: new Promise(() => {}),
				write: () => {},
				stop: async () => {
					stopped++;
				},
			}),
		};
		const client = new GithubAccountClient(
			processes,
			sleep,
			{
				pending: async () => false,
				save: async (_provider, value) => {
					pending = value;
				},
			},
			10,
			100,
		);
		expect(await client.start()).toMatchObject({ login: { state: "failed", failure: "login-failed" } });
		expect(stopped).toBeGreaterThan(0);
		expect(pending).toBe(false);
		expect(await client.cancel()).toMatchObject({ login: { state: "cancelled" } });
		await client.close();
	});
	it("reports an interrupted attempt after restart even when verification is unavailable", async () => {
		const processes: IAccountProcess = {
			initialize: async () => {},
			spawn: () => {
				throw new Error("Missing gh SECRET");
			},
		};
		const client = new GithubAccountClient(processes, sleep, { pending: async () => true, save: async () => {} });
		expect(await client.status()).toMatchObject({
			connection: "unavailable",
			login: { state: "uncertain", failure: "connection-lost" },
		});
		await client.close();
	});
});
