import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { afterEach, expect, test, vi } from "vitest";

import { AgentExecutionPool } from "../../src/agents/agent-execution-pool.ts";
import { AccessService } from "../../src/auth/access-service.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { HttpApplication } from "../../src/http/http-application.ts";
import { ProjectRouter } from "../../src/projects/project-router.ts";
import { ProjectService } from "../../src/projects/project-service.ts";
import { ProjectStore } from "../../src/projects/project-store.ts";
import { TicketPrompts } from "../../src/tickets/ticket-prompts.ts";
import { TicketRouter } from "../../src/tickets/ticket-router.ts";
import { TicketService } from "../../src/tickets/ticket-service.ts";
import { TicketStore } from "../../src/tickets/ticket-store.ts";
import { TicketWorkflowService } from "../../src/tickets/ticket-workflow-service.ts";
import { TicketWorkflowStore } from "../../src/tickets/ticket-workflow-store.ts";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("ticket HTTP create/read/edit/move persists and rejects invalid requests without exposing internals", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-ticket-http-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const db = new SqliteDatabase(join(root, "forge.sqlite"));
	cleanups.push(() => db.close());
	await db.initialize();
	const projects = new ProjectStore(db);
	await projects.initialize();
	await projects.insert({ id: projectId, name: "Forge", status: "ready", createdAt: "2026-11-03T00:00:00.000Z" });
	const store = new TicketStore(db);
	await store.initialize();
	const access = new AccessService({ owner: "owner", origin: "https://forge.example.com" });
	const workflowStore = new TicketWorkflowStore(db);
	await workflowStore.initialize();
	const workflow = new TicketWorkflowService(
		workflowStore,
		store,
		{ createTicketThread: vi.fn(), dispatch: vi.fn(), get: vi.fn(), resume: vi.fn() },
		new AgentExecutionPool(),
		{ merge: vi.fn(), base: vi.fn(), verify: vi.fn() },
		new TicketPrompts(),
		access,
	);
	const service = new TicketService(store, projects, access, () => new Date("2026-11-03T00:00:00.000Z"), workflow);
	const projectService = new ProjectService(
		projects,
		{ prepare: async () => {}, verify: async () => {} },
		access,
		() => projectId,
		() => new Date(),
	);
	const server = createServer(
		new HttpApplication(new ProjectRouter(projectService), access)
			.create([new TicketRouter(service, workflow)])
			.callback(),
	);
	cleanups.push(
		() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No listener");
	const request = (path: string, method = "GET", body?: unknown) =>
		fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
			method,
			headers: {
				"x-webauth-user": "owner",
				origin: "https://forge.example.com",
				"content-type": "application/json",
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const listPath = `projects/${projectId}/tickets`;
	const created = await request(listPath, "POST", { title: "First", description: "Scope" });
	expect(created.status).toBe(201);
	const ticket = await created.json();
	expect(ticket).toMatchObject({ id: "FORGE-1", status: "backlog" });
	expect(await (await request(`tickets/${ticket.id}`)).json()).toEqual(ticket);
	expect((await request(`tickets/${ticket.id}`, "PATCH", { title: "Edited", description: "New scope" })).status).toBe(
		200,
	);
	const moved = await request(`tickets/${ticket.id}/move`, "POST", { status: "todo" });
	expect(await moved.json()).toMatchObject({ title: "Edited", status: "todo" });
	expect(await (await request(`tickets/${ticket.id}/workflow`)).json()).toMatchObject({
		state: "queued",
		phase: "planning",
	});
	expect(await (await request(listPath)).json()).toEqual([await store.get(ticket.id)]);
	for (const [path, method, body, status] of [
		[listPath, "POST", { title: " " }, 400],
		[`tickets/${ticket.id}`, "PATCH", { title: "Task", id: "FORGE-99" }, 400],
		[`tickets/${ticket.id}/move`, "POST", { status: "invented" }, 400],
		[`tickets/${ticket.id}/move`, "POST", { status: "done", beforeId: ticket.id }, 409],
		["tickets/FORGE-999", "GET", undefined, 404],
	] as const) {
		const response = await request(path, method, body);
		expect(response.status).toBe(status);
		expect(Object.keys(await response.json())).toEqual(["error"]);
	}
});
