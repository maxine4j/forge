import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { defaultForgeSettings } from "@forge/contracts/settings";
import Router from "@koa/router";
import { expect, test, vi } from "vitest";

import { AccessService } from "../../src/auth/access-service.ts";
import type { Actor } from "../../src/auth/types.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { HttpApplication } from "../../src/http/http-application.ts";
import { SettingsRouter } from "../../src/settings/settings-router.ts";
import { SettingsService } from "../../src/settings/settings-service.ts";
import { SettingsStore } from "../../src/settings/settings-store.ts";

test("Forge settings are owner-only, origin-protected and persist across startup", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-settings-http-"));
	const origin = "https://forge.test";
	const access = new AccessService({ owner: "owner", origin });
	const path = join(root, "forge.sqlite");
	const db = new SqliteDatabase(path);
	const reopened = new SqliteDatabase(path);
	const publish = vi.fn(async () => {});
	const store = new SettingsStore(db);
	const service = new SettingsService(store, { publish }, access);
	const server = createServer(
		new HttpApplication({ create: () => new Router<{ actor: Actor }>() }, access)
			.create([new SettingsRouter(service)])
			.callback(),
	);
	try {
		await db.initialize();
		await store.initialize();
		await service.initialize();
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No listener");
		const request = (method = "GET", body?: unknown, username = "owner", requestOrigin = origin) =>
			fetch(`http://127.0.0.1:${address.port}/api/settings`, {
				method,
				headers: { "x-webauth-user": username, origin: requestOrigin, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		const settings = {
			planningInstructions: "Review the design.\nInclude rollout steps.",
			implementationInstructions: "Run tests.",
			gitName: "Forge Developer",
			gitEmail: "forge@example.com",
		};
		expect((await request("GET", undefined, "other")).status).toBe(403);
		expect((await request("PUT", settings, "owner", "https://other.test")).status).toBe(403);
		const initial = await request();
		expect(initial.status).toBe(200);
		expect(await initial.json()).toEqual(defaultForgeSettings);
		expect((await request("PUT", { ...settings, gitEmail: "" })).status).toBe(400);
		expect(
			(
				await request("PUT", {
					...settings,
					planningInstructions: "\u0001".repeat(4000),
					implementationInstructions: "\u0001".repeat(4000),
				})
			).status,
		).toBe(200);
		const saved = await request("PUT", settings);
		expect(saved.status).toBe(200);
		expect(await saved.json()).toEqual(settings);
		expect(await (await request()).json()).toEqual(settings);
		await db.close();
		await reopened.initialize();
		const recovered = new SettingsService(new SettingsStore(reopened), { publish }, access);
		await recovered.initialize();
		expect(recovered.get({ username: "owner" })).toEqual(settings);
		expect(publish).toHaveBeenLastCalledWith({ name: settings.gitName, email: settings.gitEmail });
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await Promise.all([db.close(), reopened.close()]);
		await rm(root, { recursive: true, force: true });
	}
});
