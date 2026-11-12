import { expect, test } from "vitest";

import { createTicketSchema, updateTicketSchema, moveTicketSchema, ticketSchema, ticketStatuses } from "./index.ts";

test("board exposes exactly four workflow stages", () => {
	expect(ticketStatuses).toEqual(["backlog", "todo", "in-progress", "done"]);
	expect(moveTicketSchema.safeParse({ status: "planning" }).success).toBe(false);
});

test("ticket settings are optional on creation and independent of scope edits", () => {
	const input = {
		title: "Ticket",
		executionSettings: { model: "runtime-id", reasoningEffort: "high", permissions: "full-access" },
	};
	expect(createTicketSchema.parse(input)).toEqual({ ...input, description: "", repositoryIds: [] });
	expect(updateTicketSchema.safeParse(input).success).toBe(false);
	expect(createTicketSchema.safeParse({ title: "Ticket", executionSettings: { reasoningEffort: "" } }).success).toBe(
		false,
	);
	expect(createTicketSchema.parse({ title: "Ticket", executionSettings: {} }).executionSettings).toEqual({});
});

test("tickets have bounded plain fields, immutable keys and explicit manual moves", () => {
	expect(createTicketSchema.parse({ title: "  First task  ", description: "Details" })).toEqual({
		title: "First task",
		description: "Details",
		repositoryIds: [],
	});
	for (const value of [
		{ title: " " },
		{ title: "x".repeat(121) },
		{ title: "Task", description: "x".repeat(4001) },
		{ title: "Task", status: "done" },
	])
		expect(createTicketSchema.safeParse(value).success).toBe(false);
	expect(moveTicketSchema.parse({ status: "done", beforeId: "FORGE-2" })).toEqual({
		status: "done",
		beforeId: "FORGE-2",
	});
	expect(moveTicketSchema.safeParse({ status: "unknown" }).success).toBe(false);
	expect(ticketSchema.safeParse({ id: "FORGE-0" }).success).toBe(false);
});

test("tickets have ordered references and reject ownership and duplicates", () => {
	const one = "123e4567-e89b-42d3-a456-426614174000";
	const two = "123e4567-e89b-42d3-a456-426614174001";
	expect(createTicketSchema.parse({ title: "Unassigned" }).repositoryIds).toEqual([]);
	expect(createTicketSchema.parse({ title: "References", repositoryIds: [two, one] }).repositoryIds).toEqual([
		two,
		one,
	]);
	for (const value of [
		{ title: "Duplicate", repositoryIds: [one, one] },
		{ title: "Invalid", repositoryIds: ["invalid"] },
		{ title: "Owned", projectId: one },
	])
		expect(createTicketSchema.safeParse(value).success).toBe(false);
});
