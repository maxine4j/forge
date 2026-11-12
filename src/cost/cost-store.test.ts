import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { CostStore } from "./cost-store.ts";

test("persists one usage snapshot per turn across restarts and reads all projects and isolates tickets", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-cost-"));
	const path = join(directory, "forge.sqlite");
	const date = "2026-11-11T00:00:00.000Z";
	const record = {
		projectId: "a",
		threadId: "thread",
		turnId: "turn",
		phase: "planning",
		ticketId: "TASK-1",
		startedAt: date,
		billing: {
			localCurrency: "AUD",
			monthlyPlanLocal: 30,
			usdToLocal: 1.5,
			rateDate: "2026-11-10",
			fetchedAt: date,
			rates: { input: 2, cached: 0.1, output: 10 },
		},
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
		expect(await reopened.read("TASK-1")).toMatchObject({
			since: date,
			turns: [
				{ ...record, output: 10, durationMs: 1000 },
				{ ...record, projectId: "b", threadId: "other" },
			],
		});
		expect((await reopened.read("TASK-2")).turns).toHaveLength(0);
		await db.run(
			`WITH RECURSIVE turns(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM turns WHERE n<1000)
			 INSERT INTO codex_usage(projectId,threadId,turnId,record)
			 SELECT 'a','thread','turn-'||n,json_set(?,'$.turnId','turn-'||n) FROM turns`,
			[JSON.stringify(record)],
		);
		const history = await reopened.read();
		expect(history.turns).toHaveLength(1002);
		expect(history.turns.at(-1)?.turnId).toBe("turn-1000");
	} finally {
		await db.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("concurrent notifications preserve dispatch billing, phase and model rates without repricing", async () => {
	const db = new SqliteDatabase(":memory:");
	await db.initialize();
	try {
		const store = new CostStore(db);
		await store.initialize("2026-11-12T00:00:00.000Z");
		const record = {
			projectId: "repo",
			threadId: "thread",
			turnId: "turn",
			phase: "planning" as const,
			ticketId: "TASK-1",
			startedAt: "2026-11-12T00:00:00.000Z",
			billing: {
				localCurrency: "AUD",
				monthlyPlanLocal: 30,
				usdToLocal: 1.5,
				rateDate: "2026-11-10",
				fetchedAt: "2026-11-12T00:00:00.000Z",
				rates: { input: 2, cached: 0.1, output: 10 },
			},
			input: 1000000,
			cached: 500000,
			output: 100000,
		};
		await store.save(record);
		await Promise.all(
			Array.from({ length: 10 }, () =>
				store.save({
					...record,
					phase: "implementation",
					ticketId: "TASK-2",
					billing: {
						localCurrency: "EUR",
						monthlyPlanLocal: 99,
						usdToLocal: 0.9,
						rates: { input: 100, cached: 100, output: 100 },
					},
					output: 200000,
				}),
			),
		);
		await store.save(record); // stale notification must not roll usage back
		const history = await store.read("TASK-1");
		expect(history.turns).toHaveLength(1);
		expect(history.turns[0]).toMatchObject({
			phase: "planning",
			ticketId: "TASK-1",
			billing: record.billing,
			output: 200000,
			apiUsd: 3.05,
		});
		expect((await store.read("TASK-2")).turns).toEqual([]);
		await store.save({ ...record, output: 200000, pricingUnavailable: true });
		expect((await store.read()).turns[0]?.apiUsd).toBeUndefined();
		expect((await store.read()).turns[0]?.billing).toEqual(record.billing);
	} finally {
		await db.close();
	}
});
