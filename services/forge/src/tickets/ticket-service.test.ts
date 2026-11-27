import type { Ticket, MoveTicket } from "@forge/contracts/tickets";
import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import type { IProjectStore } from "../projects/project-store.ts";
import { TicketService } from "./ticket-service.ts";
import type { ITicketStore } from "./ticket-store.ts";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const actor = { username: "owner" };
const now = new Date("2026-11-03T00:00:00.000Z");
const fixture = () => {
	const tickets = new Map<string, Ticket>();
	const store = {
		updateSettings: vi.fn(),
		insert: vi.fn(async (input, createdAt) => {
			const value: Ticket = {
				...input,
				repositoryIds: input.repositoryIds ?? [],
				createdAt,
				id: "TASK-1",
				status: "backlog",
			};
			tickets.set(value.id, value);
			return value;
		}),
		get: vi.fn(async (id) => tickets.get(id)),
		list: vi.fn(async (includeArchived = false) =>
			[...tickets.values()].filter((ticket) => includeArchived || !ticket.archivedAt),
		),
		update: vi.fn(async (id, input) => {
			Object.assign(tickets.get(id)!, input);
		}),
		archive: vi.fn(async (id: string, archivedAt: string) => {
			tickets.get(id)!.archivedAt ??= archivedAt;
		}),
		move: vi.fn(async (id: string, input: MoveTicket) => {
			tickets.get(id)!.status = input.status;
		}),
	} satisfies ITicketStore;
	const projects = {
		get: vi.fn(async () => ({
			id: projectId,
			name: "Project",
			status: "ready" as const,
			createdAt: now.toISOString(),
		})),
		insert: vi.fn(),
		list: vi.fn(),
		setStatus: vi.fn(),
	} satisfies IProjectStore;
	const summary = new Map<string, Pick<Ticket, "agentStatus" | "needsAttention">>();
	const service = new TicketService(
		store,
		projects,
		new AccessService({ owner: "owner", origin: "https://forge.example.com" }),
		() => now,
		{
			options: vi.fn(),
			clearPlan: vi.fn(),
			capabilities: vi.fn(async () => ({})),
			update: async (_actor, id, input) => store.update(id, input),
			settings: vi.fn(),
			validateSettings: vi.fn(),
			archive: async (_actor, ticket, archivedAt) => store.archive(ticket.id, archivedAt),
			move: async (_actor, ticket, input) => store.move(ticket.id, input),
			get: vi.fn(),
			boardSummary: vi.fn(async () => summary),
			approve: vi.fn(),
			queueMerge: vi.fn(),
			message: vi.fn(),
			tick: vi.fn(),
			recover: vi.fn(),
		},
		{ get: vi.fn() },
	);
	return { service, tickets, store, projects, summary };
};

test("global access and scope validation are independent of repository readiness", async () => {
	const { service, projects, store } = fixture();
	const ticket = await service.create(actor, { title: "Unassigned", description: "" });
	expect(ticket.repositoryIds).toEqual([]);
	await service.list(actor);
	await service.get(actor, ticket.id);
	expect(projects.get).not.toHaveBeenCalled();
	for (const action of [
		() => service.list({ username: "guest" }),
		() => service.get({ username: "guest" }, ticket.id),
		() => service.create({ username: "guest" }, { title: "Denied", description: "" }),
	])
		await expect(action()).rejects.toThrow("Access denied");
	projects.get.mockResolvedValueOnce(undefined!);
	await expect(
		service.create(actor, { title: "Unknown", description: "", repositoryIds: [projectId] }),
	).rejects.toThrow("invalid-request");
	await expect(
		service.update(actor, ticket.id, {
			title: "Duplicate",
			description: "",
			repositoryIds: [projectId, projectId],
		}),
	).rejects.toThrow("invalid-request");
	expect(store.insert).toHaveBeenCalledTimes(1);
	expect(store.update).not.toHaveBeenCalled();
});

test("references never limit visibility or same-column drop targets", async () => {
	const { service, tickets } = fixture();
	const ticket = await service.create(actor, { title: "Task", description: "" });
	tickets.set("TASK-2", { ...ticket, id: "TASK-2", repositoryIds: [projectId] });
	expect(await service.list(actor)).toHaveLength(2);
	await expect(service.move(actor, ticket.id, { status: "backlog", beforeId: "TASK-2" })).resolves.toMatchObject({
		id: ticket.id,
	});
});

test("archived lists require owner access and retain order without workflow indicators", async () => {
	const { service, tickets, summary, store } = fixture();
	const ticket = await service.create(actor, { title: "Task", description: "" });
	const archived = { ...ticket, id: "TASK-2", status: "todo" as const, archivedAt: now.toISOString() };
	tickets.set(archived.id, archived);
	summary.set(archived.id, { agentStatus: "queued", needsAttention: true });
	expect((await service.list(actor)).map((value) => value.id)).toEqual([ticket.id]);
	expect(await service.list(actor, true)).toEqual([ticket, archived]);
	expect(store.list).toHaveBeenLastCalledWith(true);
	await expect(service.list({ username: "guest" }, true)).rejects.toThrow("Access denied");
});

test("create backlog tickets, edit scope and delegate moves to the workflow", async () => {
	const { service } = fixture();
	const value = await service.create(actor, { repositoryIds: [projectId], title: " Task ", description: "Scope" });
	expect(value).toMatchObject({ id: "TASK-1", title: "Task", status: "backlog" });
	expect(await service.update(actor, value.id, { title: "Edited", description: "New scope" })).toMatchObject({
		title: "Edited",
	});
	for (const status of ["todo", "in-progress", "done", "backlog"] as const) {
		expect((await service.move(actor, value.id, { status })).status).toBe(status);
	}
	expect(await service.list(actor)).toHaveLength(1);
});

test("ready tickets without workflows retain their queued status; inactive cards have no icon", async () => {
	const { service, tickets } = fixture();
	const ticket = await service.create(actor, { repositoryIds: [projectId], title: "Task", description: "" });
	for (const status of ["backlog", "todo", "in-progress", "done"] as const) {
		tickets.set(ticket.id, { ...ticket, status });
		expect((await service.list(actor))[0]?.agentStatus).toBe(status === "todo" ? "queued" : undefined);
	}
});

test("list combines workflow status and attention while excluding inactive columns", async () => {
	const { service, tickets, summary } = fixture();
	const ticket = await service.create(actor, { repositoryIds: [projectId], title: "Task", description: "" });
	for (const status of ["backlog", "todo", "in-progress", "done"] as const) {
		tickets.set(ticket.id, { ...ticket, status });
		for (const flags of [
			{ agentStatus: "queued" as const },
			{ agentStatus: "working" as const },
			{ needsAttention: true as const },
			{},
		]) {
			summary.set(ticket.id, flags);
			expect((await service.list(actor))[0]).toEqual({
				...ticket,
				status,
				...(status === "todo" || status === "in-progress" ? flags : {}),
			});
		}
	}
});

test("archived tickets can be read but cannot be edited, moved or used as drop targets", async () => {
	const { service, tickets, store } = fixture();
	const ticket = await service.create(actor, { repositoryIds: [projectId], title: "Task", description: "Scope" });
	const other = { ...ticket, id: "TASK-2" };
	tickets.set(other.id, other);
	await expect(service.archive({ username: "guest" }, ticket.id)).rejects.toThrow("Access denied");
	expect(store.archive).not.toHaveBeenCalled();
	const archived = await service.archive(actor, ticket.id);
	expect(archived).toMatchObject({ ...ticket, archivedAt: now.toISOString() });
	expect(await service.get(actor, ticket.id)).toEqual(archived);
	await expect(service.update(actor, ticket.id, { title: "Changed", description: "" })).rejects.toThrow(
		"ticket-conflict",
	);
	await expect(service.move(actor, ticket.id, { status: "todo" })).rejects.toThrow("ticket-conflict");
	await expect(service.move(actor, other.id, { status: "backlog", beforeId: ticket.id })).rejects.toThrow(
		"ticket-conflict",
	);
	expect(store.update).not.toHaveBeenCalled();
	expect(store.move).not.toHaveBeenCalled();
});

test("reject invalid input, missing tickets and invalid drop targets before mutation", async () => {
	const { service, tickets, store } = fixture();
	await expect(service.create(actor, { repositoryIds: [projectId], title: " ", description: "" })).rejects.toThrow(
		"invalid-request",
	);
	await expect(service.get(actor, "TASK-999")).rejects.toThrow("ticket-not-found");
	const ticket = await service.create(actor, { repositoryIds: [projectId], title: "Task", description: "" });
	tickets.set("TASK-2", { ...ticket, id: "TASK-2", status: "todo" });
	await expect(service.move(actor, ticket.id, { status: "backlog", beforeId: "TASK-2" })).rejects.toThrow(
		"ticket-conflict",
	);
	await expect(service.move(actor, ticket.id, { status: "done", beforeId: ticket.id })).rejects.toThrow(
		"ticket-conflict",
	);
	await expect(service.move(actor, ticket.id, { status: "done", beforeId: "TASK-999" })).rejects.toThrow(
		"ticket-conflict",
	);
	expect(store.move).not.toHaveBeenCalled();
});
