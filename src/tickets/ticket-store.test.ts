import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { afterEach, expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { TicketStore } from "./ticket-store.ts";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const otherId = "123e4567-e89b-42d3-a456-426614174001";
const createdAt = "2026-11-03T00:00:00.000Z";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("SQLite allocates global sequential ticket keys, preserves global order and survives reopening", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-tickets-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "forge.sqlite");
	const db = new SqliteDatabase(path);
	cleanups.push(() => db.close());
	await db.initialize();
	const projects = new ProjectStore(db);
	await projects.initialize();
	for (const id of [projectId, otherId]) await projects.insert({ id, name: "Project", status: "ready", createdAt });
	const store = new TicketStore(db);
	await store.initialize();
	const input = { title: "Task", description: "Details" };
	const [a, b, c] = await Promise.all([
		store.insert({ ...input, repositoryIds: [projectId] }, createdAt),
		store.insert({ ...input, repositoryIds: [projectId] }, createdAt),
		store.insert({ ...input, repositoryIds: [otherId, projectId] }, createdAt),
	]);
	expect(await store.get(a.id)).toStrictEqual(a);
	expect([a.id, b.id, c.id]).toEqual(["TASK-1", "TASK-2", "TASK-3"]);
	expect(a.status).toBe("backlog");
	await store.move(b.id, { status: "backlog", beforeId: a.id });
	expect((await store.list()).map((ticket) => ticket.id)).toEqual([b.id, a.id, c.id]);
	await store.move(b.id, { status: "done" });
	await store.update(a.id, { title: "Edited", description: "Updated" });
	await store.updateSettings(a.id, {
		model: "catalog-model",
		reasoningEffort: "high",
		permissions: "approve-for-me",
	});
	await db.close();
	const reopened = new SqliteDatabase(path);
	cleanups.push(() => reopened.close());
	await reopened.initialize();
	const persisted = new TicketStore(reopened);
	await persisted.initialize();
	expect(await persisted.get(b.id)).toMatchObject({ status: "done", repositoryIds: [projectId] });
	expect(await persisted.get(a.id)).toMatchObject({ title: "Edited", description: "Updated", status: "backlog" });
	expect((await persisted.get(a.id))?.executionSettings).toEqual({
		model: "catalog-model",
		reasoningEffort: "high",
		permissions: "approve-for-me",
	});
	await persisted.updateSettings(a.id, {});
	expect((await persisted.get(a.id))?.executionSettings).toEqual({});
	expect(await persisted.list()).toHaveLength(3);
	expect((await persisted.get(c.id))?.repositoryIds).toEqual([otherId, projectId]);
	await expect(persisted.insert({ ...input, repositoryIds: [otherId, otherId] }, createdAt)).rejects.toThrow(
		"ticket-unavailable",
	);
	await expect(
		persisted.insert({ ...input, repositoryIds: ["123e4567-e89b-42d3-a456-426614174099"] }, createdAt),
	).rejects.toThrow("ticket-unavailable");
	expect(await persisted.list()).toHaveLength(3);
	expect(await persisted.get("TASK-999")).toBeUndefined();
	expect((await persisted.insert({ ...input, repositoryIds: [projectId] }, createdAt)).id).toBe("TASK-4");
	await expect(persisted.update(a.id, { title: "", description: "" })).rejects.toThrow("ticket-unavailable");
	expect((await persisted.get(a.id))?.title).toBe("Edited");
	await expect(persisted.insert({ ...input, repositoryIds: [projectId] }, "invalid timestamp")).rejects.toThrow(
		"ticket-unavailable",
	);
	expect(await persisted.list()).toHaveLength(4);
});

test("archiving an existing ticket retains its contents and frees board capacity across restarts", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-ticket-archive-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const path = join(root, "forge.sqlite");
	const db = new SqliteDatabase(path);
	cleanups.push(() => db.close());
	await db.initialize();
	const projects = new ProjectStore(db);
	await projects.initialize();
	await projects.insert({ id: projectId, name: "Project", status: "ready", createdAt });
	const store = new TicketStore(db);
	await store.initialize();
	await db.run(
		"WITH RECURSIVE positions(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM positions WHERE n<1000) INSERT INTO tickets(title,description,position,createdAt) SELECT 'Original','Scope',n,? FROM positions",
		[createdAt],
	);
	await expect(store.insert({ title: "Over capacity", description: "" }, createdAt)).rejects.toThrow(
		"ticket-unavailable",
	);
	expect(await store.list()).toHaveLength(1000);
	const original = await store.get("TASK-1000");
	expect(original?.executionSettings).toBeUndefined();
	expect(original).toMatchObject({ title: "Original", description: "Scope" });
	const archivedAt = "2026-11-04T00:00:00.000Z";
	await store.archive("TASK-1000", archivedAt);
	await store.archive("TASK-1000", "2026-11-05T00:00:00.000Z");
	await db.close();

	const reopened = new SqliteDatabase(path);
	cleanups.push(() => reopened.close());
	await reopened.initialize();
	const persisted = new TicketStore(reopened);
	await persisted.initialize();
	expect(await persisted.get("TASK-1000")).toEqual({ ...original, archivedAt });
	expect(await persisted.list()).toHaveLength(999);
	const created = await persisted.insert(
		{ repositoryIds: [projectId], title: "New task", description: "" },
		createdAt,
	);
	expect(created.id).toBe("TASK-1001");
	expect((await persisted.list()).at(-1)).toEqual(created);
	const otherProject = "123e4567-e89b-42d3-a456-426614174099";
	await new ProjectStore(reopened).insert({ id: otherProject, name: "Other", status: "ready", createdAt });
	await persisted.archive("TASK-1", archivedAt);
	const otherTicket = await persisted.insert(
		{ repositoryIds: [otherProject], title: "Other task", description: "" },
		createdAt,
	);
	const costTickets = await persisted.listForCost();
	expect(costTickets).toHaveLength(1002);
	expect(costTickets).toContainEqual({
		id: otherTicket.id,
		title: "Other task",
	});
	expect(costTickets).toContainEqual({
		id: "TASK-1000",
		title: "Original",
		archivedAt,
	});
	expect(costTickets).toContainEqual({ id: created.id, title: "New task" });
});
