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
		expect((await request("", "POST", { name: "Secret", kind: "openai", loginId: "private" })).status).toBe(400);
		const created = await request("", "POST", {
			name: " Local ",
			kind: "ollama",
			endpoint: "http://ollama/v1",
			comparisonModel: "gpt-5.4",
		});
		expect(created.status).toBe(201);
		const provider = (await created.json()) as ModelProvider;
		expect(provider).toEqual({
			id: provider.id,
			name: "Local",
			kind: "ollama",
			endpoint: "http://ollama/v1",
			comparisonModel: "gpt-5.4",
			retired: false,
		});
		expect((await request(`/${provider.id}`, "PATCH", { kind: "openai" })).status).toBe(400);
		expect(await (await request(`/${provider.id}`, "PATCH", { name: "Renamed" })).json()).toMatchObject({
			id: provider.id,
			name: "Renamed",
		});
		expect((await request(`/${provider.id}/model-options`)).status).toBe(400);
		expect((await request(`/${provider.id}`, "DELETE")).status).toBe(204);
		expect(await (await request()).json()).toEqual([]);
		expect(await (await request(`/${provider.id}/model-options`)).json()).toEqual({ error: "provider-retired" });
		expect((await request(`/${randomUUID()}`, "PATCH", { name: "Missing" })).status).toBe(404);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
