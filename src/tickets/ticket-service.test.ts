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
		insert: vi.fn(async (projectId, input, createdAt) => {
			const value: Ticket = { ...input, projectId, createdAt, id: "FORGE-1", status: "backlog" };
			tickets.set(value.id, value);
			return value;
		}),
		get: vi.fn(async (id) => tickets.get(id)),
		list: vi.fn(async (id) => [...tickets.values()].filter((ticket) => ticket.projectId === id)),
		update: vi.fn(async (id, input) => {
			Object.assign(tickets.get(id)!, input);
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
	const service = new TicketService(
		store,
		projects,
		new AccessService({ owner: "owner", origin: "https://forge.example.com" }),
		() => now,
		{
			move: async (_actor, ticket, input) => store.move(ticket.id, input),
			get: vi.fn(),
			attention: vi.fn(async () => []),
			approve: vi.fn(),
			queueMerge: vi.fn(),
			message: vi.fn(),
			tick: vi.fn(),
			recover: vi.fn(),
		},
	);
	return { service, tickets, store, projects };
};

test("create backlog tickets, edit scope and delegate moves to the workflow", async () => {
	const { service } = fixture();
	const value = await service.create(actor, projectId, { title: " Task ", description: "Scope" });
	expect(value).toMatchObject({ id: "FORGE-1", title: "Task", status: "backlog" });
	expect(await service.update(actor, value.id, { title: "Edited", description: "New scope" })).toMatchObject({
		title: "Edited",
	});
	for (const status of ["todo", "in-progress", "done", "backlog"] as const) {
		expect((await service.move(actor, value.id, { status })).status).toBe(status);
	}
	expect(await service.list(actor, projectId)).toHaveLength(1);
});

test("reject invalid input, missing tickets and invalid drop targets before mutation", async () => {
	const { service, tickets, store } = fixture();
	await expect(service.create(actor, projectId, { title: " ", description: "" })).rejects.toThrow("invalid-request");
	await expect(service.get(actor, "FORGE-999")).rejects.toThrow("ticket-not-found");
	const ticket = await service.create(actor, projectId, { title: "Task", description: "" });
	tickets.set("FORGE-2", { ...ticket, id: "FORGE-2", projectId: "123e4567-e89b-42d3-a456-426614174001" });
	await expect(service.move(actor, ticket.id, { status: "backlog", beforeId: "FORGE-2" })).rejects.toThrow(
		"ticket-conflict",
	);
	await expect(service.move(actor, ticket.id, { status: "done", beforeId: ticket.id })).rejects.toThrow(
		"ticket-conflict",
	);
	await expect(service.move(actor, ticket.id, { status: "done", beforeId: "FORGE-999" })).rejects.toThrow(
		"ticket-conflict",
	);
	expect(store.move).not.toHaveBeenCalled();
});
