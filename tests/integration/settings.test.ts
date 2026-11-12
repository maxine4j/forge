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
	const options = {
		models: [
			{
				id: "model-a",
				name: "Model A",
				isDefault: true,
				supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
			},
		],
		skills: [],
	};
	const catalog = vi.fn(async () => options);
	const store = new SettingsStore(db);
	const service = new SettingsService(store, { publish }, access, catalog);
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
		const request = (method = "GET", body?: unknown, username = "owner", requestOrigin = origin, suffix = "") =>
			fetch(`http://127.0.0.1:${address.port}/api/settings${suffix}`, {
				method,
				headers: { "x-webauth-user": username, origin: requestOrigin, "content-type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		const settings = {
			localCurrency: "AUD",
			monthlyPlanLocal: 30,
			planningInstructions: "Review the design.\nInclude rollout steps.",
			implementationInstructions: "Run tests.",
			gitName: "Forge Developer",
			gitEmail: "forge@example.com",
		};
		expect((await request("GET", undefined, "other")).status).toBe(403);
		expect((await request("GET", undefined, "other", origin, "/model-options")).status).toBe(403);
		const models = await request("GET", undefined, "owner", origin, "/model-options");
		expect(models.status).toBe(200);
		expect(await models.json()).toEqual(options);
		expect((await request("PUT", settings, "owner", "https://other.test")).status).toBe(403);
		const initial = await request();
		expect(initial.status).toBe(200);
		expect(await initial.json()).toEqual(defaultForgeSettings);
		expect((await request("PUT", { ...settings, gitEmail: "" })).status).toBe(400);
		for (const change of [{ localCurrency: "XYZ" }, { monthlyPlanLocal: -1 }, { monthlyPlanLocal: null }])
			expect((await request("PUT", { ...settings, ...change })).status).toBe(400);
		expect(
			(
				await request("PUT", {
					...settings,
					localCurrency: "AUD",
					monthlyPlanLocal: 30,
					planningInstructions: "\u0001".repeat(4000),
					implementationInstructions: "\u0001".repeat(4000),
				})
			).status,
		).toBe(200);
		expect((await request("PUT", { ...settings, defaultAgentModel: "missing" })).status).toBe(400);
		expect((await request("PUT", { ...settings, defaultAgentReasoningEffort: "low" })).status).toBe(400);
		const configured = { ...settings, defaultAgentModel: "model-a", defaultAgentReasoningEffort: "high" };
		const saved = await request("PUT", configured);
		expect(saved.status).toBe(200);
		expect(await saved.json()).toEqual(configured);
		expect(await (await request()).json()).toEqual(configured);
		catalog.mockRejectedValue(new Error("Codex offline"));
		expect((await request("GET", undefined, "owner", origin, "/model-options")).status).toBe(503);
		expect((await request("PUT", { ...configured, defaultAgentModel: undefined })).status).toBe(503);
		expect((await request("PUT", settings)).status).toBe(200);
		expect((await request("PUT", configured)).status).toBe(503);
		catalog.mockResolvedValue(options);
		expect((await request("PUT", configured)).status).toBe(200);
		catalog.mockRejectedValue(new Error("Codex offline"));
		const updated = {
			...configured,
			localCurrency: "EUR",
			monthlyPlanLocal: 45.5,
			planningInstructions: "Updated during outage.",
		};
		expect((await request("PUT", updated)).status).toBe(200);
		await db.close();
		await reopened.initialize();
		const recovered = new SettingsService(new SettingsStore(reopened), { publish }, access);
		await recovered.initialize();
		expect(recovered.get({ username: "owner" })).toEqual(updated);
		expect(publish).toHaveBeenLastCalledWith({ name: settings.gitName, email: settings.gitEmail });
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await Promise.all([db.close(), reopened.close()]);
		await rm(root, { recursive: true, force: true });
	}
});
