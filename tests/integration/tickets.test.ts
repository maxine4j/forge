import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { afterEach, expect, test, vi } from "vitest";

import { AgentExecutionPool } from "../../src/agents/agent-execution-pool.ts";
import { AccessService } from "../../src/auth/access-service.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { EpicRouter } from "../../src/epics/epic-router.ts";
import { EpicService } from "../../src/epics/epic-service.ts";
import { EpicStore } from "../../src/epics/epic-store.ts";
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
	const steer = vi.fn();
	const stopTicket = vi.fn(async () => true);
	const workflow = new TicketWorkflowService(
		workflowStore,
		store,
		{
			stopTicket,
			assertRepositoryReady: vi.fn(async () => {}),
			catalogOptions: vi.fn(async () => ({ models: [], skills: [] })),
			createTicketThread: vi.fn(),
			dispatch: vi.fn(),
			steer,
			get: vi.fn(),
			resume: vi.fn(),
			plan: vi.fn(),
		},
		new AgentExecutionPool(),
		{ isMerged: vi.fn(async () => false), merge: vi.fn(), base: vi.fn(), verify: vi.fn(), candidate: vi.fn() },
		{ cleanupMerged: vi.fn() },
		new TicketPrompts(),
		access,
	);
	const epics = new EpicStore(db);
	await epics.initialize();
	const epicService = new EpicService(epics, store, access, () => new Date("2026-11-03T00:00:00.000Z"));
	const service = new TicketService(
		store,
		projects,
		access,
		() => new Date("2026-11-03T00:00:00.000Z"),
		workflow,
		epics,
	);
	const projectService = new ProjectService(
		projects,
		{
			prepare: async () => {},
			verify: async () => {},
			hasUpstream: async () => false,
			configureUpstream: async () => {},
			upstreamUrl: async () => {
				throw new Error("No upstream");
			},
		},
		access,
		() => projectId,
		() => new Date(),
	);
	const server = createServer(
		new HttpApplication(new ProjectRouter(projectService), access)
			.create([new TicketRouter(service, workflow), new EpicRouter(epicService)])
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
	const listPath = "tickets";
	for (const method of ["GET", "POST"]) {
		expect(
			(
				await request(
					`projects/${projectId}/tickets`,
					method,
					method === "POST" ? { title: "Removed" } : undefined,
				)
			).status,
		).toBe(404);
	}
	for (const repositoryIds of [[projectId, projectId], ["123e4567-e89b-42d3-a456-426614174099"]]) {
		expect((await request(listPath, "POST", { title: "Rejected", repositoryIds })).status).toBe(400);
	}
	const unassignedResponse = await request(listPath, "POST", {
		title: "Unassigned",
		description: "\u0000".repeat(4000),
	});
	expect(unassignedResponse.status).toBe(201);
	const unassigned = await unassignedResponse.json();
	expect(unassigned).toMatchObject({ repositoryIds: [] });
	expect((await request(`tickets/${unassigned.id}/move`, "POST", { status: "todo" })).status).toBe(409);
	expect((await request(`tickets/${unassigned.id}/model-options`)).status).toBe(200);
	await request(`tickets/${unassigned.id}/archive`, "POST");
	const created = await request(listPath, "POST", {
		title: "First",
		description: "Scope",
		repositoryIds: [projectId],
	});
	expect(created.status).toBe(201);
	const ticket = await created.json();
	expect(ticket).toMatchObject({ id: "TASK-2", status: "backlog" });
	expect(await (await request(`tickets/${ticket.id}`)).json()).toEqual(ticket);
	expect(
		(
			await request(`tickets/${ticket.id}`, "PATCH", {
				title: "Edited",
				description: "New scope",
				repositoryIds: [projectId],
			})
		).status,
	).toBe(200);
	const moved = await request(`tickets/${ticket.id}/move`, "POST", { status: "todo" });
	expect(await moved.json()).toMatchObject({ title: "Edited", status: "todo" });
	expect((await request(`tickets/${ticket.id}/settings`, "PATCH", { permissions: "full-access" })).status).toBe(200);
	expect((await (await request(`tickets/${ticket.id}`)).json()).executionSettings).toEqual({
		permissions: "full-access",
	});
	expect((await request(`tickets/${ticket.id}/settings`, "PATCH", { model: "invented" })).status).toBe(400);
	expect((await request(`tickets/${ticket.id}/settings`, "PATCH", { reasoningEffort: "invented" })).status).toBe(400);
	expect(await (await request(`tickets/${ticket.id}/workflow`)).json()).toMatchObject({
		state: "queued",
		phase: "planning",
	});
	expect(await (await request(listPath)).json()).toEqual([
		{ ...(await store.get(ticket.id)), agentStatus: "queued", canReturnToBacklog: true },
	]);
	expect((await (await request(`tickets/${ticket.id}`)).json()).canReturnToBacklog).toBe(true);
	const destination = await store.insert({ title: "Backlog target", description: "" }, "2026-11-03T00:00:00.000Z");
	for (const beforeId of [ticket.id, "TASK-999", unassigned.id]) {
		expect((await request(`tickets/${ticket.id}/move`, "POST", { status: "backlog", beforeId })).status).toBe(409);
	}
	await db.run(
		"CREATE TRIGGER reject_return BEFORE UPDATE OF status ON tickets WHEN NEW.status='backlog' BEGIN SELECT RAISE(ABORT,'blocked'); END",
	);
	expect((await request(`tickets/${ticket.id}/move`, "POST", { status: "backlog" })).status).toBe(503);
	expect((await workflowStore.get(ticket.id))?.state).toBe("queued");
	expect((await store.get(ticket.id))?.status).toBe("todo");
	await db.run("DROP TRIGGER reject_return");
	expect(
		(await request(`tickets/${ticket.id}/move`, "POST", { status: "backlog", beforeId: destination.id })).status,
	).toBe(200);
	expect((await store.list()).map((value) => value.id)).toEqual([ticket.id, destination.id]);
	expect((await workflowStore.get(ticket.id))?.state).toBe("idle");
	await request(`tickets/${ticket.id}/move`, "POST", { status: "todo" });
	await request(`tickets/${ticket.id}/move`, "POST", { status: "backlog" });
	expect((await store.list()).map((value) => value.id)).toEqual([destination.id, ticket.id]);
	expect(await (await request(`tickets/${ticket.id}`)).json()).toMatchObject({
		title: "Edited",
		description: "New scope",
		repositoryIds: [projectId],
		executionSettings: { permissions: "full-access" },
	});
	await request(`tickets/${ticket.id}/move`, "POST", { status: "todo" });
	await store.archive(destination.id, "2026-11-03T00:00:00.000Z");
	const queued = (await workflowStore.get(ticket.id))!;
	for (const state of ["queued", "setup-failed"] as const) {
		await workflowStore.save({ ...queued, state, executionRepositoryId: projectId });
		expect((await (await request(`tickets/${ticket.id}`)).json()).canReturnToBacklog).toBe(true);
		expect((await request(`tickets/${ticket.id}/move`, "POST", { status: "backlog" })).status).toBe(200);
		expect(await workflowStore.get(ticket.id)).toMatchObject({ state: "idle" });
		await request(`tickets/${ticket.id}/move`, "POST", { status: "todo" });
	}
	await workflowStore.save(queued);
	for (const [path, method, body, status] of [
		[listPath, "POST", { title: " " }, 400],
		[`tickets/${ticket.id}`, "PATCH", { title: "Task", id: "TASK-99" }, 400],
		[`tickets/${ticket.id}/move`, "POST", { status: "invented" }, 400],
		[`tickets/${ticket.id}/approve`, "POST", { revision: 0 }, 400],
		[`tickets/${ticket.id}/approve`, "POST", { revision: 1 }, 409],
		[`tickets/${ticket.id}/move`, "POST", { status: "done", beforeId: ticket.id }, 409],
		["tickets/TASK-999", "GET", undefined, 404],
	] as const) {
		const response = await request(path, method, body);
		expect(response.status).toBe(status);
		expect(Object.keys(await response.json())).toEqual(["error"]);
	}
	const archived = await request(`tickets/${ticket.id}/archive`, "POST");
	expect(archived.status).toBe(200);
	const archivedTicket = await archived.json();
	expect(archivedTicket).toMatchObject({
		id: ticket.id,
		title: "Edited",
		description: "New scope",
		status: "todo",
		archivedAt: "2026-11-03T00:00:00.000Z",
	});
	expect(await (await request(`tickets/${ticket.id}`)).json()).toEqual(archivedTicket);
	expect(await (await request(`tickets/${ticket.id}/archive`, "POST")).json()).toEqual(archivedTicket);
	expect(await (await request(listPath)).json()).toEqual([]);
	expect(await workflowStore.list()).toEqual([]);
	expect(await (await request(`tickets/${ticket.id}/workflow`)).json()).toMatchObject({ state: "queued" });
	const next = await request(listPath, "POST", { title: "Next ticket" });
	expect(await next.json()).toMatchObject({ id: "TASK-4" });
	const implementerId = "123e4567-e89b-42d3-a456-426614174010";
	await workflowStore.save(
		{
			ticketId: "TASK-4",
			phase: "implementation",
			state: "running",
			mergeAttempts: 0,
			implementerId,
			turnId: "active-turn",
		},
		{ status: "in-progress" },
	);
	const messagePath = "tickets/TASK-4/messages";
	expect((await request(messagePath, "POST", { text: "Focus on tests", expectedTurnId: "active-turn" })).status).toBe(
		200,
	);
	expect(steer).toHaveBeenCalledWith({ username: "owner" }, implementerId, "active-turn", "Focus on tests");
	for (const [input, status] of [
		[{ text: "Feedback", expectedTurnId: "stale" }, 409],
		[{ text: "Feedback" }, 409],
		[{ text: "Feedback", expectedTurnId: "" }, 400],
		[{ text: "Feedback", expectedTurnId: "active-turn", model: "override" }, 400],
	] as const)
		expect((await request(messagePath, "POST", input)).status).toBe(status);
	for (const headers of [
		{ "x-webauth-user": "stranger", origin: "https://forge.example.com" },
		{ "x-webauth-user": "owner", origin: "https://other.example.com" },
	])
		expect(
			(
				await fetch(`http://127.0.0.1:${address.port}/api/${messagePath}`, {
					method: "POST",
					headers: { ...headers, "content-type": "application/json" },
					body: JSON.stringify({ text: "Feedback", expectedTurnId: "active-turn" }),
				})
			).status,
		).toBe(403);
	expect(steer).toHaveBeenCalledTimes(1);
	const savedPlan = { revision: 3, text: "Saved plan across return" };
	await workflowStore.save({ ...(await workflowStore.get("TASK-4"))!, plan: savedPlan, approvedRevision: 3 });
	stopTicket.mockResolvedValue(false);
	await db.run(
		"CREATE TRIGGER reject_abandon BEFORE UPDATE OF status ON tickets WHEN NEW.status='backlog' BEGIN SELECT RAISE(ABORT,'blocked'); END",
	);
	expect((await request("tickets/TASK-4/move", "POST", { status: "backlog", beforeId: ticket.id })).status).toBe(409);
	// An archived destination still fails validation before an atomic write.
	expect((await request("tickets/TASK-4/move", "POST", { status: "backlog" })).status).toBe(503);
	expect((await workflowStore.get("TASK-4"))?.state).toBe("running");
	expect((await store.get("TASK-4"))?.status).toBe("in-progress");
	await db.run("DROP TRIGGER reject_abandon");
	expect((await request("tickets/TASK-4/move", "POST", { status: "backlog" })).status).toBe(200);
	expect(await (await request("tickets/TASK-4/workflow")).json()).toMatchObject({
		state: "resetting",
		resetStage: "stopping",
		plan: savedPlan,
	});
	expect((await workflowStore.list()).map(({ ticketId }) => ticketId)).toContain("TASK-4");
	expect((await request("tickets/TASK-4/clear-plan", "POST")).status).toBe(409);
	expect((await request("tickets/TASK-4/move", "POST", { status: "todo" })).status).toBe(409);
	const recoveredStore = new TicketWorkflowStore(db);
	expect(await recoveredStore.get("TASK-4")).toMatchObject({
		state: "resetting",
		abandonment: { implementerId },
		plan: savedPlan,
	});
	stopTicket.mockResolvedValue(true);
	await request("tickets/TASK-4/reconcile", "POST");
	expect((await recoveredStore.get("TASK-4"))?.state).toBe("idle");
	expect(await (await request("tickets/TASK-4/clear-plan", "POST")).json()).not.toHaveProperty("plan");
	expect((await request("tickets/TASK-4/clear-plan", "POST")).status).toBe(200);
	for (const headers of [
		{ "x-webauth-user": "stranger", origin: "https://forge.example.com" },
		{ "x-webauth-user": "owner", origin: "https://other.example.com" },
	])
		expect(
			(await fetch(`http://127.0.0.1:${address.port}/api/tickets/TASK-4/clear-plan`, { method: "POST", headers }))
				.status,
		).toBe(403);

	// Independent epic identities and strict CRUD transport contracts.
	const epic = await (await request("epics", "POST", { title: "  First epic  " })).json();
	expect(epic).toMatchObject({
		id: "EPIC-1",
		title: "First epic",
		description: "",
		total: 0,
		done: 0,
		complete: false,
		children: [],
	});
	const other = await (await request("epics", "POST", { title: "Other epic", description: "Scope" })).json();
	expect(other.id).toBe("EPIC-2");
	for (const body of [
		{ title: " " },
		{ title: "x".repeat(121) },
		{ title: "Epic", description: "x".repeat(4001) },
		{ title: "Epic", epicId: epic.id },
		{ title: "Epic", complete: true },
	]) {
		expect((await request("epics", "POST", body)).status).toBe(400);
		expect((await request(`epics/${epic.id}`, "PATCH", body)).status).toBe(400);
	}
	expect((await request("epics/EPIC-999")).status).toBe(404);
	expect((await request("epics/TASK-1")).status).toBe(400);
	const draft = await (
		await request("tickets", "POST", { title: "Child", epicId: epic.id, repositoryIds: [projectId] })
	).json();
	const patch = (epicId?: string | null) =>
		request(`tickets/${draft.id}`, "PATCH", {
			title: "Edited child",
			description: "Scope",
			repositoryIds: [projectId],
			...(epicId === undefined ? {} : { epicId }),
		});
	expect(await (await patch()).json()).toMatchObject({ epicId: epic.id });
	expect(await (await patch(other.id)).json()).toMatchObject({ epicId: other.id });
	expect(await (await patch(null)).json()).toMatchObject({ epicId: null });
	expect((await patch("EPIC-999")).status).toBe(400);
	expect((await request("tickets", "POST", { title: "Unknown", epicId: "EPIC-999" })).status).toBe(400);
	await patch(epic.id);
	const child2 = await (await request("tickets", "POST", { title: "Second child", epicId: epic.id })).json();
	const child3 = await (await request("tickets", "POST", { title: "Third child", epicId: epic.id })).json();
	await store.move(child2.id, { status: "in-progress" });
	await store.move(child3.id, { status: "done" });
	let detail = await (await request(`epics/${epic.id}`)).json();
	expect(detail).toMatchObject({
		total: 3,
		done: 1,
		complete: false,
		counts: { backlog: 1, todo: 0, "in-progress": 1, done: 1 },
	});
	expect(detail.children.map((child: { id: string }) => child.id)).toEqual(
		(await store.list()).filter((child) => child.epicId === epic.id).map((child) => child.id),
	);
	await store.archive(child2.id, "2026-11-03T00:00:00.000Z");
	await patch(null);
	detail = await (await request(`epics/${epic.id}`)).json();
	expect(detail).toMatchObject({ total: 1, done: 1, complete: true });
	expect(
		await (
			await request(`epics/${epic.id}`, "PATCH", { title: "Completed but editable", description: "New" })
		).json(),
	).toMatchObject({ title: "Completed but editable", complete: true });
	await patch(epic.id);
	expect(await (await request(`epics/${epic.id}`)).json()).toMatchObject({ complete: false, total: 2 });

	// Workflow serialization makes the race resolve to one whole edit before Ready,
	// or a rejected edit after Ready. Positions are unaffected by membership edits.
	const before = (await store.list()).map((ticket) => ticket.id);
	await patch(other.id);
	expect((await store.list()).map((ticket) => ticket.id)).toEqual(before);
	await Promise.all([
		service.move({ username: "owner" }, draft.id, { status: "todo" }),
		service
			.update({ username: "owner" }, draft.id, {
				title: "Raced edit",
				description: "Race",
				repositoryIds: [projectId],
				epicId: epic.id,
			})
			.then(
				() => {
					throw new Error("Edit passed Ready");
				},
				(error: unknown) => expect(error).toMatchObject({ code: "ticket-conflict" }),
			),
	]);
	expect(await store.get(draft.id)).toMatchObject({ status: "todo", title: "Edited child", epicId: other.id });
	expect((await patch(null)).status).toBe(409);
	await store.archive(draft.id, "2026-11-03T00:00:00.000Z");
	expect((await patch(epic.id)).status).toBe(409);
	expect((await request(`tickets/${child3.id}`, "PATCH", { title: "Done", epicId: null })).status).toBe(409);
	const summaries = await (await request("epics")).json();
	expect(summaries.map((value: { id: string }) => value.id)).toEqual([epic.id, other.id]);
	expect(summaries[1]).toMatchObject({ total: 0, complete: false });
	// Exercise the workflow boundary directly, independent of the HTTP service queue.
	const owner = { username: "owner" };
	const raced = await service.create(owner, {
		title: "Workflow race",
		description: "Before",
		repositoryIds: [projectId],
		epicId: epic.id,
	});
	await Promise.all([
		workflow.update(owner, raced.id, {
			title: "Whole edit",
			description: "After",
			repositoryIds: [projectId],
			epicId: other.id,
		}),
		workflow.move(owner, raced, { status: "todo" }),
	]);
	expect(await store.get(raced.id)).toMatchObject({
		title: "Whole edit",
		description: "After",
		epicId: other.id,
		status: "todo",
	});
	await expect(
		workflow.update(owner, raced.id, { title: "Late edit", description: "", epicId: null }),
	).rejects.toMatchObject({ code: "ticket-conflict" });
	for (const path of ["epics", `epics/${epic.id}`]) {
		for (const method of ["GET", path === "epics" ? "POST" : "PATCH"]) {
			const denied = await fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
				method,
				headers: {
					"x-webauth-user": "stranger",
					origin: "https://forge.example.com",
					"content-type": "application/json",
				},
				...(method === "GET" ? {} : { body: JSON.stringify({ title: "Denied" }) }),
			});
			expect(denied.status).toBe(403);
		}
		const deniedOrigin = await fetch(`http://127.0.0.1:${address.port}/api/${path}`, {
			method: path === "epics" ? "POST" : "PATCH",
			headers: {
				"x-webauth-user": "owner",
				origin: "https://other.example.com",
				"content-type": "application/json",
			},
			body: JSON.stringify({ title: "Denied" }),
		});
		expect(deniedOrigin.status).toBe(403);
	}
});
