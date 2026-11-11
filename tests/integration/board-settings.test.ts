import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import Router from "@koa/router";
import { expect, test, vi } from "vitest";

import { AgentExecutionPool } from "../../src/agents/agent-execution-pool.ts";
import { AccessService } from "../../src/auth/access-service.ts";
import type { Actor } from "../../src/auth/types.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { HttpApplication } from "../../src/http/http-application.ts";
import { BoardSettingsRouter } from "../../src/tickets/board-settings-router.ts";
import { BoardSettingsService } from "../../src/tickets/board-settings-service.ts";
import { BoardSettingsStore } from "../../src/tickets/board-settings-store.ts";

test("owner can adjust and persist board dispatch and capacity and stop active agents", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-board-settings-"));
	const path = join(root, "forge.sqlite");
	let db = new SqliteDatabase(path);
	const access = new AccessService({ owner: "owner", origin: "https://forge.example" });
	const pool = new AgentExecutionPool();
	const agents = { stopAll: vi.fn(async () => ({ requested: 2, failed: 1 })) };
	const wake = vi.fn();
	const settingsService = async () => {
		await db.initialize();
		const store = new BoardSettingsStore(db);
		await store.initialize();
		const service = new BoardSettingsService(store, agents, pool, access, wake);
		await service.initialize();
		return service;
	};
	const servers: ReturnType<typeof createServer>[] = [];
	const listen = async (service: BoardSettingsService) => {
		const app = new HttpApplication({ create: () => new Router<{ actor: Actor }>() }, access);
		const server = createServer(app.create([new BoardSettingsRouter(service)]).callback());
		servers.push(server);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No listener");
		return (suffix = "", method = "GET", body?: unknown, origin = "https://forge.example", user = "owner") =>
			fetch(`http://127.0.0.1:${address.port}/api/board/settings${suffix}`, {
				method,
				headers: { "x-webauth-user": user, origin, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
	};
	try {
		const request = await listen(await settingsService());
		const defaults = await request();
		expect(defaults.status).toBe(200);
		expect(await defaults.json()).toEqual({ dispatch: "running", maxAgents: 3 });
		expect((await request("", "GET", undefined, undefined, "guest")).status).toBe(403);
		expect((await request("/stop", "POST", undefined, "https://elsewhere.example")).status).toBe(403);
		expect((await request("", "PATCH", { maxAgents: 0 })).status).toBe(400);
		expect((await request("", "PATCH", { dispatch: "stopped" })).status).toBe(400);
		expect(agents.stopAll).not.toHaveBeenCalled();
		expect(await (await request("", "PATCH", { dispatch: "paused", maxAgents: 1 })).json()).toEqual({
			dispatch: "paused",
			maxAgents: 1,
		});
		pool.claim("active");
		expect(pool.available()).toBe(false);
		expect(await (await request("/stop", "POST")).json()).toEqual({
			settings: { dispatch: "stopped", maxAgents: 1 },
			requested: 2,
			failed: 1,
		});
		expect(agents.stopAll).toHaveBeenCalledWith({ username: "owner" });

		await db.close();
		db = new SqliteDatabase(path);
		const afterRestart = await listen(await settingsService());
		expect(await (await afterRestart()).json()).toEqual({ dispatch: "stopped", maxAgents: 1 });
		expect(await (await afterRestart("", "PATCH", { maxAgents: 2 })).json()).toEqual({
			dispatch: "stopped",
			maxAgents: 2,
		});
		expect(pool.available()).toBe(true);
		wake.mockClear();
		expect(await (await afterRestart("", "PATCH", { dispatch: "running" })).json()).toEqual({
			dispatch: "running",
			maxAgents: 2,
		});
		expect(wake).toHaveBeenCalledOnce();
	} finally {
		await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
