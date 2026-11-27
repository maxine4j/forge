import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { afterEach, expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { ProjectStore } from "./project-store.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
test("SQLite persists validated project intents and status; missing records are explicit", async () => {
	const path = await mkdtemp(join(tmpdir(), "forge-projects-"));
	cleanups.push(() => rm(path, { recursive: true, force: true }));
	const db = new SqliteDatabase(join(path, "forge.sqlite"));
	cleanups.push(() => db.close());
	await db.initialize();
	const store = new ProjectStore(db);
	await store.initialize();
	const record = {
		id: "123e4567-e89b-42d3-a456-426614174000",
		name: "Project",
		createdAt: "2026-11-02T00:00:00.000Z",
		status: "creating" as const,
		source: "https://github.com/owner/repo",
	};
	await store.insert(record);
	await store.setStatus(record.id, "ready");
	expect(await store.get(record.id)).toEqual({ ...record, status: "ready" });
	expect(await store.list()).toEqual([{ ...record, status: "ready" }]);
	expect(await store.get("123e4567-e89b-42d3-a456-426614174001")).toBeUndefined();
	await expect(store.insert(record)).rejects.toThrow("Project storage unavailable");
	await db.run("UPDATE projects SET name = ''");
	await expect(store.list()).rejects.toThrow("Project storage unavailable");
});

test("the initial 1000-project capacity is enforced atomically before insertion", async () => {
	const path = await mkdtemp(join(tmpdir(), "forge-capacity-"));
	cleanups.push(() => rm(path, { recursive: true, force: true }));
	const db = new SqliteDatabase(join(path, "forge.sqlite"));
	cleanups.push(() => db.close());
	await db.initialize();
	const store = new ProjectStore(db);
	await store.initialize();
	await db.run(
		"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000) INSERT INTO projects SELECT printf('123e4567-e89b-42d3-a456-%012d',x), 'Project', 'creating', '2026-11-02T00:00:00.000Z', NULL FROM n",
	);
	await expect(
		store.insert({
			id: "123e4567-e89b-42d3-a456-426614174000",
			name: "Overflow",
			status: "creating",
			createdAt: "2026-11-02T00:00:00.000Z",
		}),
	).rejects.toThrow("Project storage unavailable");
	expect(await store.list()).toHaveLength(1000);
});
