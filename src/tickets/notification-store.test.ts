import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { NotificationStore, workflowNotificationKeys } from "./notification-store.ts";

test("additive metadata bootstrap preserves time across restart and gives recurring conditions new identities", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-notifications-"));
	let database = new SqliteDatabase(join(root, "db.sqlite"));
	let at = "2026-11-14T01:00:00.000Z";
	try {
		await database.initialize();
		let store = new NotificationStore(database, () => new Date(at));
		await store.initialize();
		await store.sync("workflow:TASK-1", ["failed:attempt-1"]);
		const original = await store.read();
		at = "2026-11-14T02:00:00.000Z";
		await store.initialize();
		await store.sync("workflow:TASK-1", ["failed:attempt-1"]);
		expect(await store.read()).toEqual(original);
		await database.close();
		database = new SqliteDatabase(join(root, "db.sqlite"));
		await database.initialize();
		store = new NotificationStore(database, () => new Date(at));
		await store.initialize();
		await store.sync("workflow:TASK-1", ["failed:attempt-1"]);
		expect(await store.read()).toEqual(original);
		await store.sync("workflow:TASK-1", []);
		expect(await store.read()).toEqual([]);
		await store.sync("workflow:TASK-1", ["failed:attempt-1"]);
		const recurring = (await store.read())[0]!;
		expect(recurring.id).not.toBe(original[0]!.id);
		expect(recurring.at).toBe(at);
		await store.sync("agent:one", ["approval-handle-1", "questions-handle-2"]);
		await store.sync("agent:one", ["questions-handle-2"]);
		expect((await store.read()).some((item) => item.condition === "approval-handle-1")).toBe(false);
		expect((await store.read()).filter((item) => item.source === "agent:one")).toHaveLength(1);
	} finally {
		await database.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("workflow identities distinguish revisions and attempts and clear resolved conditions", () => {
	const job = {
		ticketId: "TASK-1",
		phase: "planning" as const,
		state: "idle" as const,
		mergeAttempts: 0,
		plan: { revision: 1, text: "Plan" },
	};
	expect(workflowNotificationKeys(job)).toEqual(["plan:1"]);
	expect(workflowNotificationKeys(job, "backlog")).toEqual([]);
	expect(workflowNotificationKeys({ ...job, plan: { ...job.plan, revision: 2 } })).toEqual(["plan:2"]);
	expect(workflowNotificationKeys({ ...job, approvedRevision: 1 })).toEqual([]);
	expect(workflowNotificationKeys({ ...job, state: "queued" })).toEqual([]);
	expect(workflowNotificationKeys({ ...job, state: "failed", turnId: "one" })).not.toEqual(
		workflowNotificationKeys({ ...job, state: "failed", turnId: "two" }),
	);
	expect(workflowNotificationKeys({ ...job, state: "resetting", resetError: "Busy" })).toHaveLength(1);
});
