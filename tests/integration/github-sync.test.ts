import { once } from "node:events";
import { createServer } from "node:http";

import Router from "@koa/router";
import { expect, test, vi } from "vitest";

import { AccessService } from "../../src/auth/access-service.ts";
import type { Actor } from "../../src/auth/types.ts";
import { HttpApplication } from "../../src/http/http-application.ts";
import { GithubSyncRouter } from "../../src/repositories/github-sync-router.ts";
import { GithubSyncService } from "../../src/repositories/github-sync-service.ts";
import type { GithubSyncResult } from "../../src/repositories/types.ts";

test("GitHub sync HTTP enforces the owner and origin and reports safe outcomes", async () => {
	const id = "123e4567-e89b-42d3-a456-426614174000";
	const origin = "https://forge.example";
	const access = new AccessService({ owner: "owner", origin });
	const client = {
		status: vi.fn().mockResolvedValue({ ahead: 1, behind: 2 }),
		sync: vi.fn<(projectId: string) => Promise<GithubSyncResult>>(),
	};
	const service = new GithubSyncService(
		client,
		{
			get: async () => ({
				id,
				name: "Forge",
				status: "ready",
				createdAt: "2026-11-01T00:00:00.000Z",
				source: "https://github.com/maxine4j/forge.git",
			}),
		},
		access,
	);
	const application = new HttpApplication({ create: () => new Router<{ actor: Actor }>() }, access);
	const server = createServer(application.create([new GithubSyncRouter(service)]).callback());
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
		const url = `http://127.0.0.1:${address.port}/api/projects/${id}/repository/github-sync`;
		const headers = { "x-webauth-user": "owner", origin, "content-type": "application/json" };
		const post = (body = "{}") => fetch(url, { method: "POST", headers, body });
		expect((await fetch(url)).status).toBe(403);
		expect(
			(await fetch(url, { method: "POST", headers: { ...headers, origin: "https://other.example" } })).status,
		).toBe(403);
		expect((await post('{"branch":"other"}')).status).toBe(400);
		expect(client.sync).not.toHaveBeenCalled();
		const status = await fetch(url, { headers });
		expect(status.status).toBe(200);
		expect(await status.json()).toEqual({ state: "ready", ahead: 1, behind: 2 });

		client.sync.mockResolvedValueOnce({ outcome: "conflict" });
		const conflict = await post();
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({ error: "github-sync-conflict" });

		const head = "a".repeat(40);
		client.sync.mockResolvedValueOnce({ outcome: "push-failed", head, localUpdated: true });
		const failed = await post();
		expect(failed.status).toBe(502);
		expect(await failed.json()).toEqual({ error: "github-sync-push-failed-local-updated" });

		client.sync.mockResolvedValueOnce({ outcome: "synced", head });
		const synced = await fetch(url, { method: "POST", headers: { "x-webauth-user": "owner", origin } });
		expect(synced.status).toBe(200);
		expect(await synced.json()).toEqual({ head });
	} finally {
		server.close();
		await once(server, "close");
	}
});
