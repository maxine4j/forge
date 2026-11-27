import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { afterEach, expect, test } from "vitest";

import { SqliteDatabase } from "./sqlite-database.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const database = async () => {
	const path = await mkdtemp(join(tmpdir(), "forge-sqlite-"));
	cleanups.push(() => rm(path, { recursive: true, force: true }));
	const db = new SqliteDatabase(join(path, "forge.sqlite"));
	cleanups.push(() => db.close());
	await db.initialize();
	return { db, path };
};

test("async worker enables WAL and foreign keys, commits and rolls back bounded transactions", async () => {
	const { db } = await database();
	expect(await db.all("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
	expect(await db.all("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
	await db.run("CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
	await db.transaction([{ sql: "INSERT INTO items VALUES (?, ?)", parameters: ["one", "first"] }]);
	await expect(
		db.transaction([
			{ sql: "INSERT INTO items VALUES (?, ?)", parameters: ["two", "second"] },
			{ sql: "INSERT INTO items VALUES (?, ?)", parameters: ["one", "duplicate"] },
		]),
	).rejects.toThrow("Database operation failed");
	expect(await db.all("SELECT * FROM items")).toEqual([{ id: "one", value: "first" }]);
	await expect(db.transaction(Array.from({ length: 101 }, () => ({ sql: "SELECT 1" })))).rejects.toThrow();
});

test("serialized concurrent writes persist across close and reopen; close refuses more work", async () => {
	const { db, path } = await database();
	await db.run("CREATE TABLE counts (value INTEGER NOT NULL)");
	await db.run("INSERT INTO counts VALUES (0)");
	await Promise.all(Array.from({ length: 20 }, () => db.run("UPDATE counts SET value = value + 1")));
	await db.close();
	await expect(db.all("SELECT 1")).rejects.toThrow();
	const reopened = new SqliteDatabase(join(path, "forge.sqlite"));
	cleanups.push(() => reopened.close());
	await reopened.initialize();
	expect(await reopened.all("SELECT value FROM counts")).toEqual([{ value: 20 }]);
});

test("startup failures reject rather than hanging; results and failures remain bounded and sanitized", async () => {
	const { db, path } = await database();
	const bad = new SqliteDatabase(join(path, "missing", "forge.sqlite"));
	cleanups.push(() => bad.close());
	await expect(bad.initialize()).rejects.toThrow("Database operation failed");
	await expect(db.all("SELECT SECRET_DIAGNOSTIC")).rejects.toThrow(/^Database operation failed$/);
	await expect(
		db.all("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1001) SELECT x FROM n"),
	).rejects.toThrow();
});

test("worker death rejects every pending operation, and synchronous worker failures are sanitized", async () => {
	const dead = new SqliteDatabase(
		":memory:",
		() =>
			new Worker(
				"const {parentPort}=require('node:worker_threads'); parentPort.postMessage({ready:true}); parentPort.on('message',()=>process.exit(2));",
				{ eval: true },
			),
	);
	cleanups.push(() => dead.close());
	await dead.initialize();
	const results = await Promise.allSettled([dead.all("SELECT 1"), dead.all("SELECT 2")]);
	expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
	const unspawnable = new SqliteDatabase(":memory:", () => {
		throw new Error("SECRET");
	});
	await expect(unspawnable.initialize()).rejects.toThrow(/^Database operation failed$/);
	const { db } = await database();
	await expect(db.all(Symbol("uncloneable") as unknown as string)).rejects.toThrow(/^Database operation failed$/);
	expect(await db.all("SELECT 1 as value")).toEqual([{ value: 1 }]);
});
