import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { TicketStore } from "../tickets/ticket-store.ts";
import { EpicStore } from "./epic-store.ts";

test("epic allocation survives concurrent stores and restart; foreign keys protect membership and atomic edits", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-epics-"));
	const path = join(root, "forge.sqlite");
	let db = new SqliteDatabase(path);
	const createdAt = "2026-11-03T00:00:00.000Z";
	try {
		await db.initialize();
		await new ProjectStore(db).initialize();
		const store = new EpicStore(db);
		await store.initialize();
		const tickets = new TicketStore(db);
		await tickets.initialize();
		const other = new EpicStore(db);
		const epics = await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				(index % 2 ? store : other).insert({ title: `Epic ${index}` }, createdAt),
			),
		);
		expect(new Set(epics.map((epic) => epic.id)).size).toBe(20);
		expect((await store.list()).map((epic) => epic.id)).toEqual(
			Array.from({ length: 20 }, (_, index) => `EPIC-${index + 1}`),
		);
		const ticket = await tickets.insert({ title: "Standalone", description: "" }, createdAt);
		expect(ticket).toMatchObject({ id: "TASK-1", epicId: null });
		await tickets.update(ticket.id, { title: "Assigned", description: "", epicId: "EPIC-1" });
		await expect(
			tickets.update(ticket.id, { title: "Must roll back", description: "", epicId: "EPIC-999" }),
		).rejects.toThrow("ticket-unavailable");
		expect(await tickets.get(ticket.id)).toMatchObject({ title: "Assigned", epicId: "EPIC-1" });
		await expect(db.run("DELETE FROM epics WHERE id=?", ["EPIC-1"])).rejects.toThrow();
		await db.close();
		db = new SqliteDatabase(path);
		await db.initialize();
		const reopened = new EpicStore(db);
		await reopened.initialize();
		expect((await reopened.insert({ title: "After restart" }, createdAt)).id).toBe("EPIC-21");
		expect(await new TicketStore(db).get(ticket.id)).toMatchObject({ epicId: "EPIC-1" });
		await expect(reopened.update("EPIC-999", { title: "Missing" })).rejects.toThrow("epic-not-found");
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
