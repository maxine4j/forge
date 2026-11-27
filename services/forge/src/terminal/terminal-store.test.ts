import type { TerminalSession } from "@forge/contracts/terminal";
import { afterEach, expect, it } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { TerminalStore } from "./terminal-store.ts";

const database = new SqliteDatabase(":memory:");
afterEach(() => database.close());
it("persists normalized status, recovers active intent as lost and retains final status", async () => {
	await database.initialize();
	await database.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");
	await database.run("INSERT INTO workspaces VALUES (?)", ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
	const store = new TerminalStore(database);
	await store.initialize();
	const session: TerminalSession = {
		id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
		workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
		cols: 80,
		rows: 24,
		status: "starting",
		createdAt: "2026-01-01T00:00:00Z",
	};
	await store.insert(session);
	await store.loseActive("2026-01-01T01:00:00Z");
	const lost = { ...session, status: "lost", endedAt: "2026-01-01T01:00:00Z" };
	expect(await store.get(session.id)).toEqual(lost);
	expect(await store.latest(session.workspaceId)).toEqual(lost);
	await store.update({ ...session, status: "closed" });
	await store.loseActive("2026-01-01T02:00:00Z");
	expect((await store.get(session.id))?.status).toBe("closed");
});
