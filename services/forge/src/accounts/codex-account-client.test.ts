import { describe, expect, it } from "vitest";

import { CodexAccountClient } from "./codex-account-client.ts";
import type { ICodexConnection } from "./codex-connection.ts";

describe("CodexAccountClient", () => {
	it("keeps a pending attempt uncertain after disconnect even when the server reports a late completion", async () => {
		let notification: (method: string, params: unknown) => void = () => {};
		let attempt = 0;
		const connection: ICodexConnection = {
			initialize: async () => {},
			restart: async () => {},
			close: async () => {},
			subscribe: (listener) => {
				notification = listener;
				return () => {};
			},
			request: async (method) => {
				if (method === "account/read") return { requiresOpenaiAuth: true, account: null };
				if (method === "account/login/cancel") return { status: "canceled" };
				return {
					type: "chatgptDeviceCode",
					loginId: `id-${++attempt}`,
					verificationUrl: "https://auth.openai.com/codex/device",
					userCode: "CODE",
				};
			},
		};
		const client = new CodexAccountClient(connection, { pending: async () => false, save: async () => {} });
		await client.start();
		notification("connection/lost", {});
		notification("account/login/completed", { loginId: "id-1", success: true });
		expect(await client.status()).toMatchObject({ login: { state: "uncertain" } });
		await client.cancel();
		await client.start();
		notification("account/login/completed", { loginId: "id-1", success: false });
		expect(await client.status()).toMatchObject({ login: { state: "pending" } });
	});
	it("retains uncertain login across application restart, and never replays start on status", async () => {
		let pending = false;
		const calls: string[] = [];
		const store = {
			pending: async () => pending,
			save: async (_provider: string, value: boolean) => {
				pending = value;
			},
		};
		const connection: ICodexConnection = {
			initialize: async () => {},
			restart: async () => {},
			close: async () => {},
			subscribe: () => () => {},
			request: async (method) => {
				calls.push(method);
				if (method === "account/login/start") throw new Error("lost response SECRET");
				return { requiresOpenaiAuth: true, account: null };
			},
		};
		const first = new CodexAccountClient(connection, store);
		expect(await first.start()).toMatchObject({ login: { state: "uncertain" } });
		const restarted = new CodexAccountClient(connection, store);
		expect(await restarted.status()).toMatchObject({ connection: "available", login: { state: "uncertain" } });
		expect(calls.filter((method) => method === "account/login/start")).toHaveLength(1);
		await restarted.cancel();
		expect(pending).toBe(false);
	});
	it("requires a verified account after completion and discards raw failure diagnostics", async () => {
		let notification: (method: string, params: unknown) => void = () => {};
		let account: unknown = null;
		const connection: ICodexConnection = {
			initialize: async () => {},
			restart: async () => {},
			close: async () => {},
			subscribe: (listener) => {
				notification = listener;
				return () => {};
			},
			request: async (method) =>
				method === "account/read"
					? { account, requiresOpenaiAuth: true }
					: {
							type: "chatgptDeviceCode",
							loginId: "login-1",
							verificationUrl: "https://auth.openai.com/codex/device",
							userCode: "ABCD-EFGH",
						},
		};
		const client = new CodexAccountClient(connection, { pending: async () => false, save: async () => {} });
		expect(await client.start()).toMatchObject({ login: { state: "pending", userCode: "ABCD-EFGH" } });
		notification("account/login/completed", { loginId: "login-1", success: true });
		expect(await client.status()).toMatchObject({ login: { state: "failed" } });
		await client.start();
		account = { type: "chatgpt", email: "owner@example.com", planType: "plus" };
		notification("account/login/completed", { loginId: "login-1", success: true });
		expect(await client.status()).toMatchObject({
			account: { name: "owner@example.com" },
			login: { state: "completed" },
		});
	});

	it("surfaces connection loss as uncertain and refuses unsafe verification URLs", async () => {
		let notification: (method: string, params: unknown) => void = () => {};
		const connection: ICodexConnection = {
			initialize: async () => {},
			restart: async () => {},
			close: async () => {},
			subscribe: (listener) => {
				notification = listener;
				return () => {};
			},
			request: async () => ({
				type: "chatgptDeviceCode",
				loginId: "id",
				verificationUrl: "https://evil.test/token",
				userCode: "CODE",
			}),
		};
		const client = new CodexAccountClient(connection, { pending: async () => false, save: async () => {} });
		expect(await client.start()).toMatchObject({ login: { state: "uncertain" } });
		notification("connection/lost", {});
		expect(JSON.stringify(await client.status())).not.toContain("evil.test");
	});
});
