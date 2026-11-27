import type { Epic, Ticket } from "@forge/contracts/tickets";
import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import type { ITicketStore } from "../tickets/ticket-store.ts";
import { EpicService } from "./epic-service.ts";
import type { IEpicStore } from "./epic-store.ts";

const fixture = () => {
	const epic: Epic = {
		id: "EPIC-1",
		title: "Milestone",
		description: "Scope",
		createdAt: "2026-11-03T00:00:00.000Z",
	};
	const children: Ticket[] = [];
	const store = {
		list: vi.fn(async () => [epic]),
		get: vi.fn(async (id: string) => (id === epic.id ? epic : undefined)),
		insert: vi.fn(async () => epic),
		update: vi.fn(),
	} satisfies IEpicStore;
	const tickets = {
		list: vi.fn(async () => children),
		get: vi.fn(),
		insert: vi.fn(),
		update: vi.fn(),
		move: vi.fn(),
		archive: vi.fn(),
		updateSettings: vi.fn(),
	} satisfies ITicketStore;
	const service = new EpicService(
		store,
		tickets,
		new AccessService({ owner: "owner", origin: "https://forge.example.com" }),
		() => new Date(epic.createdAt),
	);
	const child = (id: number, status: Ticket["status"], epicId: string | null = epic.id): Ticket => ({
		id: `TASK-${id}`,
		title: "Child",
		description: "",
		repositoryIds: [],
		createdAt: epic.createdAt,
		status,
		epicId,
	});
	return { service, children, child, store, tickets, epic };
};
const owner = { username: "owner" };

test("summary counts and detail share non-archived children in ticket order; completion follows membership", async () => {
	const { service, children, child } = fixture();
	expect(await service.get(owner, "EPIC-1")).toMatchObject({ total: 0, done: 0, complete: false });
	children.push(
		child(4, "done"),
		child(2, "todo"),
		child(1, "backlog"),
		child(3, "in-progress"),
		child(5, "done", null),
		{ ...child(6, "backlog"), archivedAt: "2026-11-04T00:00:00.000Z" },
	);
	const detail = await service.get(owner, "EPIC-1");
	expect(detail).toMatchObject({
		total: 4,
		done: 1,
		complete: false,
		counts: { backlog: 1, todo: 1, "in-progress": 1, done: 1 },
	});
	expect(detail.children.map((ticket) => ticket.id)).toEqual(["TASK-4", "TASK-2", "TASK-1", "TASK-3"]);
	const { children: _children, ...summary } = detail;
	expect(await service.list(owner)).toEqual([summary]);
	for (const ticket of children.slice(0, 4)) ticket.status = "done";
	expect(await service.get(owner, "EPIC-1")).toMatchObject({ total: 4, done: 4, complete: true });
	children[5]!.archivedAt = undefined;
	expect(await service.get(owner, "EPIC-1")).toMatchObject({ total: 5, complete: false });
	children[5]!.epicId = "EPIC-2";
	expect(await service.get(owner, "EPIC-1")).toMatchObject({ total: 4, complete: true });
});

test("service validates scope and identity and authorizes every operation before reading or writing", async () => {
	const { service, store, tickets, epic } = fixture();
	const stranger = { username: "guest" };
	for (const operation of [
		() => service.list(stranger),
		() => service.get(stranger, epic.id),
		() => service.create(stranger, { title: "Denied" }),
		() => service.update(stranger, epic.id, { title: "Denied" }),
	])
		await expect(operation()).rejects.toThrow("Access denied");
	expect(store.list).not.toHaveBeenCalled();
	expect(store.get).not.toHaveBeenCalled();
	expect(store.insert).not.toHaveBeenCalled();
	expect(store.update).not.toHaveBeenCalled();
	expect(tickets.list).not.toHaveBeenCalled();
	await expect(service.get(owner, "TASK-1")).rejects.toThrow("invalid-request");
	await expect(service.get(owner, "EPIC-999")).rejects.toThrow("epic-not-found");
	await expect(service.create(owner, { title: " " })).rejects.toThrow("invalid-request");
	await expect(service.update(owner, epic.id, { title: "Valid", description: "x".repeat(4001) })).rejects.toThrow(
		"invalid-request",
	);
	await service.create(owner, { title: "  Trimmed  " });
	expect(store.insert).toHaveBeenCalledWith({ title: "Trimmed", description: "" }, epic.createdAt);
});
