import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { TicketStore } from "./ticket-store.ts";
import { TicketWorkflowStore } from "./ticket-workflow-store.ts";

test("workflow intent and board movement are atomic, durable, and scheduled in board order", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-workflow-store-"));
	let db = new SqliteDatabase(join(root, "db.sqlite"));
	try {
		await db.initialize();
		const projects = new ProjectStore(db);
		await projects.initialize();
		const projectId = "123e4567-e89b-42d3-a456-426614174000";
		const createdAt = "2026-11-03T00:00:00.000Z";
		await projects.insert({ id: projectId, name: "Project", status: "ready", createdAt });
		let tickets = new TicketStore(db);
		await tickets.initialize();
		let jobs = new TicketWorkflowStore(db);
		await jobs.initialize();
		const one = await tickets.insert(projectId, { title: "One", description: "" }, createdAt);
		const two = await tickets.insert(projectId, { title: "Two", description: "" }, createdAt);
		const job = {
			ticketId: one.id,
			phase: "planning" as const,
			state: "queued" as const,
			mergeAttempts: 0,
		};
		await jobs.save(job, { status: "todo" });
		await jobs.save({ ...job, ticketId: two.id }, { status: "todo", beforeId: one.id });
		expect((await jobs.list()).map((record) => record.ticketId)).toEqual([two.id, one.id]);
		await db.run(
			"CREATE TRIGGER reject_done BEFORE UPDATE OF status ON tickets WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'blocked'); END",
		);
		await expect(jobs.save({ ...job, state: "idle" }, { status: "done" })).rejects.toThrow("ticket-unavailable");
		expect(await jobs.get(one.id)).toEqual(job);
		expect((await tickets.get(one.id))?.status).toBe("todo");
		await db.close();
		db = new SqliteDatabase(join(root, "db.sqlite"));
		await db.initialize();
		jobs = new TicketWorkflowStore(db);
		tickets = new TicketStore(db);
		expect(await jobs.get(one.id)).toEqual(job);
		expect((await tickets.get(one.id))?.status).toBe("todo");
		await jobs.save({ ...job, state: "idle" });
		expect((await jobs.list()).map((record) => record.ticketId)).toEqual([two.id]);

		await db.run("UPDATE tickets SET status='in-review' WHERE id=?", [one.id]);
		await db.run("UPDATE tickets SET status='merging' WHERE id=?", [two.id]);
		await db.run(
			"UPDATE ticket_workflows SET record=json_set(record,'$.phase','rebase','$.run',1) WHERE ticketId=?",
			[two.id],
		);
		await jobs.initialize();
		await jobs.initialize();
		expect((await tickets.get(one.id))?.status).toBe("in-progress");
		expect((await tickets.get(two.id))?.status).toBe("in-progress");
		expect(await jobs.get(one.id)).toMatchObject({ phase: "review", state: "idle" });
		expect(await jobs.get(two.id)).toMatchObject({ phase: "rebase", state: "merge-queued" });
		expect(await jobs.attention(projectId)).toEqual([one.id]);
		await db.run("DROP TRIGGER reject_done");
		const done = {
			...(await jobs.get(two.id))!,
			state: "idle" as const,
			workspaceId: "123e4567-e89b-42d3-a456-426614174001",
			resultSha: "a".repeat(40),
		};
		await jobs.save(done, { status: "done" });
		await tickets.archive(two.id, createdAt);
		expect(await jobs.pendingCleanup()).toEqual([done]);
		await jobs.save({ ...done, workspaceCleaned: true });
		expect(await jobs.pendingCleanup()).toEqual([]);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
