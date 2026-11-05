import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { expect, it } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { AccountAttemptStore } from "./account-attempt-store.ts";

it("persists interrupted-attempt metadata in SQLite across restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-account-attempt-"));
	const database = new SqliteDatabase(join(directory, "forge.sqlite"));
	let reopened: SqliteDatabase | undefined;
	try {
		await database.initialize();
		const store = new AccountAttemptStore(database);
		await store.initialize();
		expect(await store.pending("codex")).toBe(false);
		await store.save("codex", true);
		await database.close();
		reopened = new SqliteDatabase(join(directory, "forge.sqlite"));
		await reopened.initialize();
		const restored = new AccountAttemptStore(reopened);
		await restored.initialize();
		expect(await restored.pending("codex")).toBe(true);
		expect(await restored.pending("github")).toBe(false);
		await restored.save("codex", false);
		expect(await restored.pending("codex")).toBe(false);
	} finally {
		await database.close();
		await reopened?.close();
		await rm(directory, { recursive: true, force: true });
	}
});
