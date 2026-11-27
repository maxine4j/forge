import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { afterEach, expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { TicketHistoryStore } from "./ticket-history-store.ts";
import { TicketStore } from "./ticket-store.ts";
import { TicketWorkflowStore } from "./ticket-workflow-store.ts";
import type { TicketWorkflowRecord } from "./types.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const at = "2026-11-13T12:00:00.000Z";
async function setup() {
	const directory = await mkdtemp(join(tmpdir(), "forge-history-"));
	cleanup.push(() => rm(directory, { recursive: true, force: true }));
	const db = new SqliteDatabase(join(directory, "db.sqlite"));
	cleanup.push(() => db.close());
	await db.initialize();
	await new ProjectStore(db).initialize();
	const tickets = new TicketStore(db, () => new Date(at));
	await tickets.initialize();
	const workflow = new TicketWorkflowStore(db, () => new Date(at));
	await workflow.initialize();
	const history = new TicketHistoryStore(db, () => new Date(at));
	const ticket = await tickets.insert({ title: "History", description: "private scope", repositoryIds: [] }, at);
	return { directory, db, tickets, workflow, history, ticket };
}

test("ordered visits are atomic, survive archive/restart, and ignore reordering", async () => {
	const { directory, db, tickets, workflow, history, ticket } = await setup();
	await expect(
		tickets.insert(
			{ title: "Rejected", description: "", repositoryIds: ["123e4567-e89b-42d3-a456-426614174000"] },
			at,
		),
	).rejects.toThrow();
	expect(await db.all("SELECT ticketId FROM ticket_history")).toEqual([{ ticketId: ticket.id }]);
	const job: TicketWorkflowRecord = { ticketId: ticket.id, phase: "planning", state: "queued", mergeAttempts: 0 };
	await workflow.save(job, { status: "todo" });
	const before = await history.read(ticket.id, 0);
	await workflow.save(job, { status: "todo" });
	expect(await history.read(ticket.id, 0)).toEqual(before);
	await tickets.move(ticket.id, { status: "backlog" });
	await tickets.move(ticket.id, { status: "todo" });
	await tickets.move(ticket.id, { status: "in-progress" });
	await db.run(
		"CREATE TRIGGER reject_done BEFORE UPDATE OF status ON tickets WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'blocked'); END",
	);
	const snapshot = await history.read(ticket.id, 0);
	await expect(workflow.save({ ...job, state: "idle" }, { status: "done" })).rejects.toThrow();
	expect(await history.read(ticket.id, 0)).toEqual(snapshot);
	expect((await workflow.get(ticket.id))?.state).toBe("queued");
	await tickets.move(ticket.id, { status: "backlog" });
	await tickets.archive(ticket.id, at);
	await db.close();
	const reopened = new SqliteDatabase(join(directory, "db.sqlite"));
	cleanup.push(() => reopened.close());
	await reopened.initialize();
	await new TicketStore(reopened).initialize();
	const result = await new TicketHistoryStore(reopened).read(ticket.id, 0);
	expect(result.events.filter((event) => event.type === "status").map((event) => event.status)).toEqual([
		"backlog",
		"todo",
		"backlog",
		"todo",
		"in-progress",
		"backlog",
	]);
	expect(result.events.at(-2)?.type).toBe("canceled");
	expect(result.bootstrapped).toBe(false);
});

test("additive bootstrap uses recording time and is idempotent without inventing past transitions", async () => {
	const { db, tickets, history, ticket } = await setup();
	// Model the pre-history schema with an existing archived ticket.
	await db.run("DELETE FROM ticket_history WHERE ticketId=?", [ticket.id]);
	await tickets.move(ticket.id, { status: "done" });
	await db.run("DELETE FROM ticket_history WHERE ticketId=?", [ticket.id]);
	await tickets.archive(ticket.id, at);
	await tickets.initialize();
	await tickets.initialize();
	const result = await history.read(ticket.id, 0);
	expect(result).toMatchObject({
		recordedFrom: at,
		bootstrapped: true,
		events: [{ status: "done", at, type: "status" }],
	});
	expect(result.events).toHaveLength(1);
});

test("workflow milestones preserve revisions, failures, retries, merge attempts and cleanup without private contents", async () => {
	const { workflow, history, ticket } = await setup();
	let job: TicketWorkflowRecord = { ticketId: ticket.id, phase: "planning", state: "queued", mergeAttempts: 0 };
	const save = async (change: Partial<TicketWorkflowRecord>) => {
		job = { ...job, ...change };
		await workflow.save(job);
		await workflow.save(job);
	};
	await workflow.save(job, { status: "in-progress" });
	await save({ state: "dispatching" });
	await save({ state: "idle", plan: { revision: 1, text: "SECRET PLAN" } });
	await save({ state: "queued", message: "SECRET FEEDBACK" });
	await save({ state: "dispatching" });
	await save({ state: "idle", plan: { revision: 2, text: "SECRET PLAN" } });
	await save({ approvedRevision: 2, phase: "implementation", state: "queued" });
	await save({ state: "setup-failed" });
	await save({ state: "queued" });
	await save({ state: "dispatching" });
	await save({ state: "running", turnId: "private-turn" });
	await save({ state: "merge-queued", resultSha: "a".repeat(40) });
	await save({ phase: "rebase", state: "queued", mergeAttempts: 1 });
	await save({ state: "dispatching" });
	await save({ state: "failed" });
	await save({ state: "queued" });
	await save({ state: "dispatching" });
	await save({ state: "merge-queued", resultSha: "b".repeat(40) });
	await workflow.save({ ...job, state: "idle" }, { status: "done" });
	await workflow.save({ ...job, state: "idle" }, { status: "done" });
	await save({ workspaceCleaned: true, state: "idle" });
	const result = await history.read(ticket.id, 0);
	expect(result.events.filter((event) => event.type === "failure")).toHaveLength(2);
	expect(result.events.filter((event) => event.type === "retry")).toHaveLength(2);
	expect(result.events.filter((event) => event.type === "merged")).toHaveLength(1);
	expect(result.events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ type: "plan-adjusted", revision: 2 }),
			expect.objectContaining({ type: "merged" }),
			expect.objectContaining({ type: "cleanup", outcome: "completed" }),
		]),
	);
	expect(JSON.stringify(result)).not.toMatch(/SECRET|private-turn|resultSha|workspaceId/u);
});

test("agent synchronization records waiting/resume independently, suppresses repeats and rejects abandoned turns", async () => {
	const { workflow, history, ticket, tickets } = await setup();
	const id = "123e4567-e89b-42d3-a456-426614174000";
	const job: TicketWorkflowRecord = {
		ticketId: ticket.id,
		phase: "planning",
		state: "running",
		mergeAttempts: 0,
		plannerId: id,
		turnId: "turn-1",
		workspaceId: id,
	};
	await workflow.save(job, { status: "in-progress" });
	const agent = {
		id,
		workspaceId: id,
		projectId: id,
		title: "Agent",
		createdAt: at,
		managed: true,
		turnId: "turn-1",
		status: "waiting" as const,
		requests: [],
	};
	await history.observe(agent);
	await history.observe(agent);
	await history.observe({ ...agent, status: "running" });
	await history.observe({ ...agent, status: "waiting" });
	expect((await history.read(ticket.id, 0)).events.filter((event) => event.type === "action-required")).toHaveLength(
		2,
	);
	await tickets.move(ticket.id, { status: "backlog" });
	await workflow.save({ ...job, state: "resetting", resetStage: "cleanup" });
	const before = await history.read(ticket.id, 0);
	await history.observe({ ...agent, status: "failed" });
	await history.observe({ ...agent, status: "running", turnId: "older-turn" });
	expect(await history.read(ticket.id, 0)).toEqual(before);
	expect(before.events.at(-1)).toMatchObject({ type: "cleanup", status: "in-progress" });
});

test("cursor pages are bounded and deterministic even when timestamps tie", async () => {
	const { tickets, history, ticket } = await setup();
	for (let i = 0; i < 105; i++) await tickets.move(ticket.id, { status: i % 2 ? "backlog" : "todo" });
	const first = await history.read(ticket.id, 0);
	const second = await history.read(ticket.id, first.nextCursor!);
	expect(first.events).toHaveLength(100);
	expect(second.events).toHaveLength(58);
	expect(second.nextCursor).toBeUndefined();
	expect(second.events[0]!.id).toBeGreaterThan(first.nextCursor!);
	expect(new Set([...first.events, ...second.events].map((event) => event.id)).size).toBe(158);
});

test("admission precedes dispatch and waiting activity without duplicating milestones", async () => {
	const { workflow, history, ticket } = await setup();
	const id = "123e4567-e89b-42d3-a456-426614174000";
	const job: TicketWorkflowRecord = {
		ticketId: ticket.id,
		phase: "planning",
		state: "dispatching",
		mergeAttempts: 0,
		plannerId: id,
		workspaceId: id,
	};
	await workflow.save({ ...job, state: "queued" }, { status: "todo" });
	await workflow.save({ ...job, state: "queued" }, { status: "in-progress" });
	await workflow.save(job);
	await history.observe({
		id,
		projectId: id,
		workspaceId: id,
		title: "Planner",
		createdAt: at,
		managed: true,
		turnId: "turn",
		status: "waiting",
		requests: [],
	});
	const running = { ...job, state: "running" as const, turnId: "turn" };
	await workflow.save(running);
	const snapshot = await history.read(ticket.id, 0);
	await workflow.save(running);
	expect(await history.read(ticket.id, 0)).toEqual(snapshot);
	expect(snapshot.events.slice(-2)).toMatchObject([
		{ type: "planning", outcome: "working", status: "in-progress" },
		{ type: "action-required", outcome: "action-required", status: "in-progress" },
	]);
});

test("merge and setup retries retain distinct failures even when the last turn identity is unchanged", async () => {
	const { workflow, history, ticket } = await setup();
	const job: TicketWorkflowRecord = {
		ticketId: ticket.id,
		phase: "rebase",
		state: "merge-queued",
		mergeAttempts: 3,
		implementerId: "123e4567-e89b-42d3-a456-426614174000",
		turnId: "completed-turn",
	};
	await workflow.save(job, { status: "in-progress" });
	await workflow.save({ ...job, state: "failed" });
	await workflow.save(job);
	await workflow.save({ ...job, state: "failed" });
	await workflow.save({ ...job, state: "queued" });
	await workflow.save({ ...job, state: "setup-failed" });
	const events = (await history.read(ticket.id, 0)).events;
	expect(events.filter((event) => event.type === "failure")).toHaveLength(3);
	expect(events.filter((event) => event.type === "retry")).toHaveLength(2);
});

test("cancellation associates existing execution cleanup before moving its known status visit", async () => {
	for (const status of ["todo", "in-progress"] as const) {
		const { tickets, ticket, workflow, history } = await setup();
		await tickets.move(ticket.id, { status });
		const job: TicketWorkflowRecord = {
			ticketId: ticket.id,
			phase: "planning",
			state: "resetting",
			mergeAttempts: 0,
			resetStage: "stopping",
			abandonment: { workspaceId: "123e4567-e89b-42d3-a456-426614174000" },
		};
		await workflow.save(job, { status: "backlog" });
		await workflow.save({ ...job, resetStage: "cleanup" });
		expect((await history.read(ticket.id, 0)).events.at(-1)).toMatchObject({
			type: "cleanup",
			outcome: "working",
			status,
		});
	}
});
