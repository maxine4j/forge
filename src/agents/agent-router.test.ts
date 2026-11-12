import { once } from "node:events";
import { createServer } from "node:http";

import { sleep } from "@forge/backend-infrastructure/sleep";
import Router from "@koa/router";
import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import { HttpApplication } from "../http/http-application.ts";
import { AgentRouter } from "./agent-router.ts";
import type { IAgentService } from "./agent-service.ts";
import { AgentError } from "./errors.ts";

test("owner/origin validation, bounded inputs, safe failures and reconnectable SSE invalidations", async () => {
	const id = "123e4567-e89b-42d3-a456-426614174000";
	const view = {
		thread: {
			id,
			projectId: id,
			workspaceId: id,
			title: "Chat",
			createdAt: "2026-11-03T00:00:00.000Z",
			status: "idle" as const,
		},
		items: [],
		requests: [],
		truncated: false,
	};
	let changed = () => {};
	const detach = vi.fn();
	const service: IAgentService = {
		projectOptions: vi.fn(async () => ({ models: [], skills: [] })),
		options: vi.fn(async () => ({ models: [], skills: [] })),
		files: vi.fn(async () => ["src/main.ts"]),
		create: vi.fn(async () => view),
		list: async () => [view.thread],
		get: async () => view,
		send: vi.fn(async () => view),
		resume: async () => view,
		interrupt: async () => {
			throw new AgentError("agent-conflict", { cause: new Error("SECRET") });
		},
		reply: vi.fn(async () => view),
		subscribe: async (_actor, _id, listener) => {
			changed = listener;
			return detach;
		},
		shutdown: async () => {},
	};
	const router = new AgentRouter(service, sleep);
	const server = createServer(
		new HttpApplication(
			{ create: () => new Router() },
			new AccessService({ owner: "owner", origin: "https://forge.example" }),
		)
			.create([router])
			.callback(),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No port");
	const request = (path: string, method = "GET", body?: unknown, user = "owner", origin = "https://forge.example") =>
		fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
			method,
			headers: { "x-webauth-user": user, origin, "content-type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	try {
		expect(await (await request(`agents/${id}/options`)).json()).toEqual({ models: [], skills: [] });
		expect(await (await request(`agents/${id}/files?query=main`)).json()).toEqual(["src/main.ts"]);
		expect(service.files).toHaveBeenCalledWith({ username: "owner" }, id, "main");
		expect((await request(`agents/${id}/files?query=${"x".repeat(501)}`)).status).toBe(400);
		expect((await request(`projects/${id}/agents`, "POST", { title: "Chat" })).status).toBe(201);
		expect(await (await request(`projects/${id}/agents`)).json()).toEqual([view.thread]);
		expect((await request(`agents/${id}/messages`, "POST", { text: "Hello" })).status).toBe(200);
		expect(vi.mocked(service.send).mock.calls[0]?.[3]).toStrictEqual({});
		expect((await request(`agents/${id}/messages`, "POST", { text: "" })).status).toBe(400);
		expect((await request(`agents/${id}/messages`, "POST", { text: "Hello" }, "outsider")).status).toBe(403);
		expect(
			(await request(`agents/${id}/messages`, "POST", { text: "Hello" }, "owner", "https://evil.example")).status,
		).toBe(403);
		expect(service.send).toHaveBeenCalledTimes(1);
		const conflict = await request(`agents/${id}/interrupt`, "POST", {});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toEqual({ error: "agent-conflict" });
		const response = await request(`agents/${id}/events`);
		expect(response.headers.get("content-type")).toContain("text/event-stream");
		const reader = response.body!.getReader();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: changed");
		changed();
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("data: changed");
		await reader.cancel();
	} finally {
		await router.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	expect(detach).toHaveBeenCalledOnce();
});
