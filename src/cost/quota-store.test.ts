import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { TicketStore } from "../tickets/ticket-store.ts";
import { TicketWorkflowStore } from "../tickets/ticket-workflow-store.ts";
import { CostStore } from "./cost-store.ts";
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
		const ticket = await tickets.insert({ repositoryIds: [projectId], title: "One", description: "" }, date);
		const legacy = await tickets.insert({ repositoryIds: [projectId], title: "Legacy", description: "" }, date);
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

test("allocation intervals are durable, idempotent and conserve ambiguous bucket consumption", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-attribution-"));
	const path = join(root, "db.sqlite");
	let db = new SqliteDatabase(path);
	try {
		await db.initialize();
		const costs = new CostStore(db);
		await costs.initialize("2026-11-12T00:00:00.000Z");
		const store = new QuotaStore(db, costs);
		await store.initialize();
		const observation = (minute: number, usedPercent: number, bucketId = "codex") => ({
			bucketId,
			bucket: bucketId,
			minutes: 10080 as const,
			resetsAt: "2026-11-15T00:00:00.000Z",
			usedPercent,
			observedAt: `2026-11-12T00:0${minute}:00.000Z`,
		});
		await store.capture([observation(0, 10)], observation(0, 10).observedAt);
		const turn = {
			projectId: "repo",
			threadId: "thread",
			turnId: "turn",
			phase: "planning" as const,
			ticketId: "TASK-1",
			startedAt: observation(0, 10).observedAt,
			billing: {
				localCurrency: "AUD",
				monthlyPlanLocal: 30,
				usdToLocal: 1.5,
				rates: { input: 2, cached: 0.1, output: 10 },
			},
			input: 1000,
			cached: 0,
			output: 100,
		};
		await costs.save(turn);
		await Promise.all(
			Array.from({ length: 10 }, () => store.capture([observation(5, 10.5)], observation(5, 10.5).observedAt)),
		);
		const intervals = await store.intervals();
		expect(intervals).toHaveLength(1);
		expect(intervals[0]).toMatchObject({
			consumption: 0.5,
			unallocated: 0,
			allocations: [{ percent: 0.5, threadId: "thread", turnId: "turn" }],
		});
		await store.capture([observation(6, 20, "a"), observation(6, 30, "b")], observation(6, 20).observedAt);
		await costs.save({ ...turn, input: 2000 });
		await store.capture([observation(7, 21, "a"), observation(7, 32, "b")], observation(7, 21).observedAt);
		expect((await store.intervals()).slice(1)).toMatchObject([
			{ bucketId: "a", consumption: 1, unallocated: 1, allocations: [] },
			{ bucketId: "b", consumption: 2, unallocated: 2, allocations: [] },
		]);
		await db.close();
		db = new SqliteDatabase(path);
		await db.initialize();
		const reopened = new QuotaStore(db, new CostStore(db));
		await reopened.initialize();
		expect(await reopened.intervals()).toHaveLength(3);
		expect((await reopened.intervals())[0]).toEqual(intervals[0]);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
