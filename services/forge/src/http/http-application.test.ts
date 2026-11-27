import { once } from "node:events";
import { createServer, type Server } from "node:http";

import { afterEach, expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import { ProjectNotFoundError, ProjectUnavailableError } from "../projects/errors.ts";
import { ProjectRouter } from "../projects/project-router.ts";
import { HttpApplication } from "./http-application.ts";

const id = "123e4567-e89b-42d3-a456-426614174000";
const project = { id, name: "Project", status: "ready" as const, createdAt: "2026-11-02T00:00:00.000Z" };
const servers: Server[] = [];
afterEach(async () => {
	await Promise.all(
		servers
			.splice(0)
			.map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					),
			),
	);
});
const fixture = async () => {
	const projects = {
		create: vi.fn(async () => project),
		list: vi.fn(async () => [project]),
		get: vi.fn(async () => project),
		retry: vi.fn(async () => project),
		recover: vi.fn(async () => {}),
	};
	const app = new HttpApplication(
		new ProjectRouter(projects),
		new AccessService({ owner: "owner", origin: "https://forge.example.com" }),
	).create([], {
		read: async (path) =>
			path.startsWith("/api")
				? undefined
				: { bytes: Buffer.from("<main>Forge</main>"), type: "text/html", immutable: false },
	});
	const server = createServer(app.callback());
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No listening port");
	const base = `http://127.0.0.1:${address.port}`;
	return { projects, request: (path: string, options?: RequestInit) => fetch(`${base}${path}`, options) };
};

test("HTTP routes validate input and pass the PaaS actor to project services", async () => {
	const { request, projects } = await fixture();
	const headers = {
		"x-webauth-user": "Owner",
		origin: "https://forge.example.com",
		"content-type": "application/json",
	};
	expect((await request("/health")).status).toBe(200);
	let response = await request("/api/projects", {
		method: "POST",
		headers,
		body: JSON.stringify({ name: "Project" }),
	});
	expect(response.status).toBe(201);
	expect(await response.json()).toEqual(project);
	expect(projects.create).toHaveBeenCalledWith({ username: "owner" }, { name: "Project" });
	response = await request("/api/projects", { headers });
	expect(await response.json()).toEqual([project]);
	expect((await request(`/api/projects/${id}`, { headers })).status).toBe(200);
	expect((await request(`/api/projects/${id}/retry`, { method: "POST", headers })).status).toBe(200);
	response = await request("/api/projects", {
		method: "POST",
		headers,
		body: JSON.stringify({ name: "Project", source: "/etc" }),
	});
	expect(response.status).toBe(400);
	expect((await request("/api/projects/not-a-uuid", { headers })).status).toBe(400);
});

test("frontend inherits owner access, HEAD and security headers; unknown APIs remain JSON 404", async () => {
	const { request } = await fixture();
	expect((await request("/")).status).toBe(403);
	const headers = { "x-webauth-user": "owner" };
	const response = await request("/projects/one", { headers });
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/html");
	expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
	expect(response.headers.get("content-security-policy")).toContain("style-src-elem 'self' 'unsafe-inline'");
	expect(response.headers.get("content-security-policy")).not.toContain("unsafe-eval");
	expect(await response.text()).toBe("<main>Forge</main>");
	expect(await (await request("/", { headers, method: "HEAD" })).text()).toBe("");
	const missing = await request("/api/missing", { headers });
	expect(missing.status).toBe(404);
	expect(await missing.json()).toEqual({ error: "not-found" });
});

test("access and origin checks precede parsing/effects; API errors never expose diagnostics", async () => {
	const { request, projects } = await fixture();
	expect((await request("/api/projects")).status).toBe(403);
	expect((await request("/api/projects", { headers: { "x-webauth-user": "other" } })).status).toBe(403);
	expect(
		(await request("/api/projects", { method: "POST", headers: { "x-webauth-user": "owner" }, body: "not-json" }))
			.status,
	).toBe(403);
	expect(projects.create).not.toHaveBeenCalled();
	const headers = {
		"x-webauth-user": "owner",
		origin: "https://forge.example.com",
		"content-type": "application/json",
	};
	expect((await request("/api/projects", { method: "POST", headers, body: "{" })).status).toBe(400);
	projects.get.mockRejectedValueOnce(new ProjectNotFoundError());
	expect((await request(`/api/projects/${id}`, { headers })).status).toBe(404);
	projects.create.mockRejectedValueOnce(new ProjectUnavailableError({ cause: new Error("SECRET") }));
	const response = await request("/api/projects", { method: "POST", headers, body: '{"name":"Project"}' });
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({ error: "project-unavailable" });
	projects.list.mockRejectedValueOnce(new Error("SECRET"));
	expect(await (await request("/api/projects", { headers })).json()).toEqual({ error: "internal-error" });
	projects.list.mockResolvedValueOnce([{ ...project, name: "" }]);
	expect((await request("/api/projects", { headers })).status).toBe(500);
});
