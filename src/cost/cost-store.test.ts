import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { CostStore } from "./cost-store.ts";

test("persists one usage snapshot per turn across restarts and scopes reads by project", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-cost-"));
	const path = join(directory, "forge.sqlite");
	const date = "2026-11-11T00:00:00.000Z";
	const record = {
		projectId: "a",
		threadId: "thread",
		turnId: "turn",
		phase: "planning",
		ticketId: "FORGE-1",
		startedAt: date,
		monthlyAud: 30,
		input: 20,
		cached: 10,
		output: 3,
	} as const;
	let db = new SqliteDatabase(path);
	try {
		await db.initialize();
		const store = new CostStore(db);
		await store.initialize(date);
		await store.save(record);
		await store.save({ ...record, output: 10, durationMs: 1000 });
		await store.save({ ...record, projectId: "b", threadId: "other" });
		await db.close();
		db = new SqliteDatabase(path);
		await db.initialize();
		const reopened = new CostStore(db);
		await reopened.initialize("2026-11-12T00:00:00.000Z");
		expect(await reopened.read("a")).toEqual({ since: date, turns: [{ ...record, output: 10, durationMs: 1000 }] });
		expect((await reopened.read("b")).turns).toHaveLength(1);
		await db.run(
			`WITH RECURSIVE turns(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM turns WHERE n<1000)
			 INSERT INTO codex_usage(projectId,threadId,turnId,record)
			 SELECT 'a','thread','turn-'||n,json_set(?,'$.turnId','turn-'||n) FROM turns`,
			[JSON.stringify(record)],
		);
		const history = await reopened.read("a");
		expect(history.turns).toHaveLength(1001);
		expect(history.turns.at(-1)?.turnId).toBe("turn-1000");
	} finally {
		await db.close();
		await rm(directory, { recursive: true, force: true });
	}
});
