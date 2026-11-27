import type { Ticket } from "@forge/contracts/tickets";
import { expect, test } from "vitest";

import { compareBacklogTickets } from "./backlog-sort.ts";

const ticket = (fields: Partial<Ticket> = {}): Ticket => ({
	id: "TASK-1",
	title: "Ticket",
	description: "",
	repositoryIds: [],
	status: "backlog",
	createdAt: "2026-11-14T00:00:00.000Z",
	...fields,
});

test("status takes precedence over activity and key", () => {
	const tickets = [
		ticket({ status: "done", needsAttention: true }),
		ticket({ status: "backlog", needsAttention: true }),
		ticket({ status: "todo", needsAttention: true }),
		ticket({ id: "TASK-10", status: "in-progress" }),
	];
	expect(tickets.toSorted(compareBacklogTickets).map((value) => value.status)).toEqual([
		"in-progress",
		"todo",
		"backlog",
		"done",
	]);
});

test.each([false, true])("activity precedence and overlapping flags (archived: %s)", (archived) => {
	const tickets = [
		ticket({ id: "TASK-1" }),
		ticket({ id: "TASK-2", agentStatus: "queued" }),
		ticket({ id: "TASK-3", resetting: true, agentStatus: "working" }),
		ticket({ id: "TASK-4", resetting: true }),
		ticket({ id: "TASK-5", agentStatus: "working" }),
		ticket({ id: "TASK-6", needsAttention: true, resetting: true, agentStatus: "working" }),
		ticket({ id: "TASK-7", needsAttention: true, agentStatus: "queued" }),
	].map((value) => ticket({ ...value, archivedAt: archived ? value.createdAt : undefined }));
	expect(tickets.toSorted(compareBacklogTickets).map((value) => value.id)).toEqual([
		"TASK-6",
		"TASK-7",
		"TASK-5",
		"TASK-2",
		"TASK-3",
		"TASK-4",
		"TASK-1",
	]);
});

test("archives follow every active ticket and retain status tie-breakers", () => {
	const archivedAt = "2026-11-14T00:00:00.000Z";
	const tickets = [
		ticket({ id: "TASK-1", archivedAt, status: "backlog" }),
		ticket({ id: "TASK-2", archivedAt, status: "in-progress", needsAttention: true }),
		ticket({ id: "TASK-3", status: "done" }),
	];
	expect(tickets.toSorted(compareBacklogTickets).map((value) => value.id)).toEqual(["TASK-3", "TASK-2", "TASK-1"]);
});

test("numeric keys break ties without mutating the input array or tickets", () => {
	const tickets = Object.freeze([
		Object.freeze(ticket({ id: "TASK-10" })),
		Object.freeze(ticket({ id: "TASK-2" })),
		Object.freeze(ticket({ id: "TASK-1" })),
	]);
	expect(tickets.toSorted(compareBacklogTickets).map((value) => value.id)).toEqual(["TASK-1", "TASK-2", "TASK-10"]);
	expect(tickets.map((value) => value.id)).toEqual(["TASK-10", "TASK-2", "TASK-1"]);
	expect(compareBacklogTickets(tickets[0]!, tickets[0]!)).toBe(0);
});
