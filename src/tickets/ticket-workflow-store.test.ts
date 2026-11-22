import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { TicketStore } from "./ticket-store.ts";
import { TicketWorkflowStore } from "./ticket-workflow-store.ts";
import { ticketWorkflowSummary } from "./types.ts";

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
		const one = await tickets.insert({ repositoryIds: [projectId], title: "One", description: "" }, createdAt);
		const two = await tickets.insert({ repositoryIds: [projectId], title: "Two", description: "" }, createdAt);
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
		const structured = {
			goals: "Goal",
			scope: "Scope",
			decisions: "Decision",
			acceptanceCriteria: "Criteria",
			tests: "Tests",
			subtasks: [
				{
					number: 1,
					title: "Work",
					files: "a.ts",
					dependencies: "None",
					expectedChanges: "Change",
					exclusions: "None",
					completionCriteria: "Done",
				},
			],
		};
		const savedPlan = { revision: 1, text: "Original", structured };
		await jobs.save({ ...job, plan: savedPlan });
		expect((await jobs.get(one.id))?.plan).toEqual(savedPlan);
		expect(ticketWorkflowSummary((await jobs.get(one.id))!).plan).toEqual(savedPlan);
		await jobs.save({ ...job, plan: { revision: 1, text: "Legacy" } });
		expect((await jobs.get(one.id))?.plan).toEqual({ revision: 1, text: "Legacy" });
		await jobs.save({ ...job, state: "idle" });
		expect((await jobs.list()).map((record) => record.ticketId)).toEqual([two.id]);

		await jobs.save(job, { status: "in-progress" });
		await jobs.save({ ...job, ticketId: two.id }, { status: "in-progress", beforeId: one.id });
		await jobs.initialize();
		expect((await jobs.boardSummary()).map((record) => record.ticketId)).toEqual([two.id, one.id]);
		const otherProjectId = "123e4567-e89b-42d3-a456-426614174001";
		await new ProjectStore(db).insert({ id: otherProjectId, name: "Other", status: "ready", createdAt });
		const other = await tickets.insert(
			{ repositoryIds: [otherProjectId], title: "Other", description: "" },
			createdAt,
		);
		await jobs.save({ ...job, ticketId: other.id }, { status: "todo" });
		expect((await jobs.boardSummary()).map((record) => record.ticketId)).toEqual([two.id, other.id, one.id]);
		await tickets.archive(one.id, createdAt);
		expect((await jobs.boardSummary()).map((record) => record.ticketId)).toEqual([two.id, other.id]);
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

		const legacySnapshot = { configuration: { kind: "ollama", endpoint: "http://original/v1", model: "original" } };
		await db.run("UPDATE ticket_workflows SET record=? WHERE ticketId=?", [
			JSON.stringify({ ...job, providerSnapshot: legacySnapshot }),
			one.id,
		]);
		await db.close();
		db = new SqliteDatabase(join(root, "db.sqlite"));
		await db.initialize();
		jobs = new TicketWorkflowStore(db);
		const normalized = (await jobs.get(one.id))!;
		expect(normalized.planningProviderSnapshot).toEqual(legacySnapshot);
		expect(normalized.implementationProviderSnapshot).toEqual(legacySnapshot);
		expect(normalized).not.toHaveProperty("providerSnapshot");
		await jobs.save(normalized);
		expect(await jobs.get(one.id)).toEqual(normalized);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
