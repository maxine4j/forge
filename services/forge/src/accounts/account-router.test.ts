import { once } from "node:events";
import { createServer } from "node:http";

import { expect, it, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import { HttpApplication } from "../http/http-application.ts";
import { ProjectRouter } from "../projects/project-router.ts";
import { AccountRouter } from "./account-router.ts";

it("authorizes setup/status/cancel/retry, rejects extra input and exposes only safe DTOs", async () => {
	const state = {
		connection: "available" as const,
		login: { state: "pending" as const, verificationUrl: "https://github.com/login/device", userCode: "ABCD-EFGH" },
	};
	const service = {
		status: vi.fn(async () => ({ codex: state, github: state })),
		start: vi.fn(async () => state),
		cancel: vi.fn(async () => ({ ...state, login: { state: "cancelled" as const } })),
	};
	const projects = { list: async () => [], create: vi.fn(), get: vi.fn(), retry: vi.fn(), recover: async () => {} };
	const router = new AccountRouter(service);
	const server = createServer(
		new HttpApplication(
			new ProjectRouter(projects),
			new AccessService({ owner: "owner", origin: "https://forge.test" }),
		)
			.create([router])
			.callback(),
	);
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No listener");
		const request = (path: string, options?: RequestInit) =>
			fetch(`http://127.0.0.1:${address.port}${path}`, options);
		const headers = { "x-webauth-user": "owner", origin: "https://forge.test", "content-type": "application/json" };
		expect((await request("/api/accounts")).status).toBe(403);
		expect(
			(
				await request("/api/accounts/codex/login", {
					method: "POST",
					headers: { ...headers, origin: "https://evil.test" },
				})
			).status,
		).toBe(403);
		expect(service.start).not.toHaveBeenCalled();
		expect(await (await request("/api/accounts", { headers })).json()).toEqual({ codex: state, github: state });
		expect(await (await request("/api/accounts/codex/login", { method: "POST", headers })).json()).toEqual(state);
		expect(service.start).toHaveBeenCalledWith({ username: "owner" }, "codex");
		expect((await request("/api/accounts/codex/retry", { method: "POST", headers })).status).toBe(200);
		expect((await request("/api/accounts/github/cancel", { method: "POST", headers })).status).toBe(200);
		expect((await request("/api/accounts/other/login", { method: "POST", headers })).status).toBe(400);
		expect(
			(await request("/api/accounts/codex/login", { method: "POST", headers, body: '{"apiKey":"SECRET"}' }))
				.status,
		).toBe(400);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
