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

test("SQLite allocates global sequential ticket keys, preserves project order and survives reopening", async () => {
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
		store.insert(projectId, input, createdAt),
		store.insert(projectId, input, createdAt),
		store.insert(otherId, input, createdAt),
	]);
	expect([a.id, b.id, c.id]).toEqual(["FORGE-1", "FORGE-2", "FORGE-3"]);
	expect(a.status).toBe("backlog");
	await store.move(b.id, { status: "backlog", beforeId: a.id });
	expect((await store.list(projectId)).map((ticket) => ticket.id)).toEqual([b.id, a.id]);
	await store.move(b.id, { status: "done" });
	await store.update(a.id, { title: "Edited", description: "Updated" });
	await db.close();
	const reopened = new SqliteDatabase(path);
	cleanups.push(() => reopened.close());
	await reopened.initialize();
	const persisted = new TicketStore(reopened);
	await persisted.initialize();
	expect(await persisted.get(b.id)).toMatchObject({ status: "done", projectId });
	expect(await persisted.get(a.id)).toMatchObject({ title: "Edited", description: "Updated", status: "backlog" });
	expect(await persisted.list(otherId)).toEqual([c]);
	expect(await persisted.get("FORGE-999")).toBeUndefined();
	expect((await persisted.insert(projectId, input, createdAt)).id).toBe("FORGE-4");
	await expect(persisted.update(a.id, { title: "", description: "" })).rejects.toThrow("ticket-unavailable");
	expect((await persisted.get(a.id))?.title).toBe("Edited");
	await expect(persisted.insert(projectId, input, "invalid timestamp")).rejects.toThrow("ticket-unavailable");
	expect(await persisted.list(projectId)).toHaveLength(3);
});
