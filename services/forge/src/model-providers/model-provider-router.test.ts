import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import type { ModelProvider } from "@forge/contracts/model-providers";
import Router from "@koa/router";
import { expect, test } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import { HttpApplication } from "../http/http-application.ts";
import { ModelProviderRouter } from "./model-provider-router.ts";
import { ModelProviderService } from "./model-provider-service.ts";

test("provider HTTP routes require owner/origin, expose safe records and return explicit selection errors", async () => {
	const access = new AccessService({ owner: "owner", origin: "https://forge.test" });
	const values = new Map<string, ModelProvider>();
	const service = new ModelProviderService(
		{
			list: async () => [...values.values()].filter((p) => !p.retired),
			get: async (id) => values.get(id),
			save: async (p) => {
				values.set(p.id, p);
			},
		},
		access,
		randomUUID,
		async (p) => ({
			models: p.kind === "ollama" ? [{ id: p.model, name: p.model, isDefault: true }] : [],
			skills: [],
		}),
		undefined,
		undefined,
		async (p) => {
			if (p.kind === "ollama") throw new Error("offline");
			return "healthy";
		},
	);
	const server = createServer(
		new HttpApplication({ create: () => new Router() }, access)
			.create([new ModelProviderRouter(service)])
			.callback(),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing port");
	const request = (path = "", method = "GET", body?: unknown, user = "owner", origin = "https://forge.test") =>
		fetch(`http://127.0.0.1:${address.port}/api/model-providers${path}`, {
			method,
			headers: { "x-webauth-user": user, origin, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	try {
		expect((await request("", "GET", undefined, "other")).status).toBe(403);
		expect((await request("", "POST", {}, "owner", "https://other.test")).status).toBe(403);
		expect(await (await request()).json()).toEqual([]);
		expect((await request("/health", "GET", undefined, "other")).status).toBe(403);
		expect(await (await request("/health")).json()).toEqual([]);
		expect((await request("", "POST", { name: "Secret", kind: "openai", loginId: "private" })).status).toBe(400);
		const created = await request("", "POST", {
			name: " Local ",
			kind: "ollama",
			endpoint: "http://ollama/v1",
			comparisonModel: "gpt-5.4",
		});
		expect(created.status).toBe(201);
		const provider = (await created.json()) as ModelProvider;
		const second = (await (await request("", "POST", { name: "OpenAI", kind: "openai" })).json()) as ModelProvider;
		const health = await request("/health");
		expect(health.headers.get("cache-control")).toBe("no-store");
		expect(await health.json()).toEqual([
			{ providerId: provider.id, status: "unhealthy" },
			{ providerId: second.id, status: "healthy" },
		]);
		expect(provider).toEqual({
			id: provider.id,
			name: "Local",
			kind: "ollama",
			endpoint: "http://ollama/v1",
			comparisonModel: "gpt-5.4",
			retired: false,
			maxConcurrentAgents: 1,
		});
		for (const maxConcurrentAgents of [0, -1, 1.5, "2"])
			expect((await request(`/${provider.id}`, "PATCH", { maxConcurrentAgents })).status).toBe(400);
		expect((await request(`/${provider.id}`, "PATCH", { kind: "openai" })).status).toBe(400);
		expect(
			await (await request(`/${provider.id}`, "PATCH", { name: "Renamed", maxConcurrentAgents: 4 })).json(),
		).toMatchObject({
			id: provider.id,
			name: "Renamed",
			maxConcurrentAgents: 4,
		});
		expect((await request(`/${provider.id}/model-options`)).status).toBe(400);
		expect((await request(`/${provider.id}`, "DELETE")).status).toBe(204);
		expect(await (await request("/health")).json()).toEqual([{ providerId: second.id, status: "healthy" }]);
		expect((await request("", "GET")).status).toBe(200);
		expect(await (await request(`/${provider.id}/model-options`)).json()).toEqual({ error: "provider-retired" });
		expect((await request(`/${randomUUID()}`, "PATCH", { name: "Missing" })).status).toBe(404);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
