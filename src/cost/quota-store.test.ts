import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { TicketStore } from "../tickets/ticket-store.ts";
import { TicketWorkflowStore } from "../tickets/ticket-workflow-store.ts";
import { QuotaStore } from "./quota-store.ts";

test("quota and first completions survive restart and initialization, including archives", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-quota-"));
	const path = join(root, "db.sqlite");
	let db = new SqliteDatabase(path);
	const date = "2026-11-12T00:00:00.000Z";
	const sample = {
		bucketId: "stable",
		bucket: "Display",
		observedAt: date,
		minutes: 10080 as const,
		usedPercent: 40,
		resetsAt: "2026-11-15T00:00:00.000Z",
	};
	try {
		await db.initialize();
		const projects = new ProjectStore(db);
		await projects.initialize();
		const projectId = "123e4567-e89b-42d3-a456-426614174000";
		await projects.insert({ id: projectId, name: "Project", status: "ready", createdAt: date });
		const tickets = new TicketStore(db);
		await tickets.initialize();
		const ticket = await tickets.insert(projectId, { title: "One", description: "" }, date);
		const legacy = await tickets.insert(projectId, { title: "Legacy", description: "" }, date);
		await tickets.move(legacy.id, { status: "done" });
		const workflows = new TicketWorkflowStore(db, () => new Date(date));
		await workflows.initialize();
		const job = { ticketId: ticket.id, phase: "implementation" as const, state: "idle" as const, mergeAttempts: 0 };
		await db.run(
			"CREATE TRIGGER reject_done BEFORE UPDATE OF status ON tickets WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'blocked'); END",
		);
		await expect(workflows.save(job, { status: "done" })).rejects.toThrow();
		expect(await db.all("SELECT * FROM ticket_completions")).toEqual([]);
		await db.run("DROP TRIGGER reject_done");
		await workflows.save(job, { status: "done" });
		await new TicketWorkflowStore(db, () => new Date("2026-11-13T00:00:00.000Z")).save(job, { status: "done" });
		await db.run("UPDATE tickets SET archivedAt=? WHERE id=?", [date, ticket.id]);
		const store = new QuotaStore(db);
		await store.initialize();
		await store.initialize();
		await store.save(sample);
		await store.save(sample);
		await db.close();
		db = new SqliteDatabase(path);
		await db.initialize();
		await new TicketWorkflowStore(db).initialize();
		const reopened = new QuotaStore(db);
		await reopened.initialize();
		expect(await reopened.read(date)).toEqual({ observations: [sample], completions: [date] });
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
