import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { ProjectStore } from "../projects/project-store.ts";
import { WorkspaceStore } from "../workspaces/workspace-store.ts";
import { AgentThreadStore } from "./agent-thread-store.ts";

test("persists thread identities and approvals; startup makes execution uncertain and invalidates requests", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-agents-"));
	const path = join(root, "db.sqlite");
	let db = new SqliteDatabase(path);
	try {
		await db.initialize();
		const projects = new ProjectStore(db);
		await projects.initialize();
		const id = "123e4567-e89b-42d3-a456-426614174000";
		const createdAt = "2026-11-03T00:00:00.000Z";
		await projects.insert({ id, name: "Project", status: "ready", createdAt });
		const workspaces = new WorkspaceStore(db);
		await workspaces.initialize();
		await workspaces.insert({
			id,
			projectId: id,
			name: "Chat",
			branch: `forge/workspace/${id}`,
			status: "ready",
			createdAt,
		});
		let store = new AgentThreadStore(db);
		await store.initialize();
		const record = {
			id,
			projectId: id,
			workspaceId: id,
			title: "Chat",
			status: "running" as const,
			codexId: "codex-id",
			provider: { kind: "ollama" as const, endpoint: "http://ollama.internal/v1", model: "local:latest" },
			turnId: "turn",
			createdAt,
			requests: [{ id: "request", kind: "file" as const, description: "Edit", questions: [] }],
		};
		await store.insert(record);
		expect(await store.list(id)).toEqual([record]);
		await db.close();
		db = new SqliteDatabase(path);
		await db.initialize();
		store = new AgentThreadStore(db);
		await store.initialize();
		expect(await store.get(id)).toEqual(record);
		await store.recover();
		expect(await store.get(id)).toEqual({ ...record, status: "uncertain", requests: [] });
		await store.update({ ...record, status: "completed", requests: [] });
		await store.recover();
		expect((await store.get(id))?.status).toBe("completed");
		expect(await store.get("missing")).toBeUndefined();
		await expect(store.update({ ...record, id: "123e4567-e89b-42d3-a456-426614174001" })).rejects.toThrow(
			"agent-not-found",
		);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
