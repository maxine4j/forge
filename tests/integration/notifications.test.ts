import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import type { AgentThreadRecord } from "../../src/agents/types.ts";
import { AccessService } from "../../src/auth/access-service.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { ProjectStore } from "../../src/projects/project-store.ts";
import { NotificationService } from "../../src/tickets/notification-service.ts";
import { NotificationStore } from "../../src/tickets/notification-store.ts";
import { TicketStore } from "../../src/tickets/ticket-store.ts";
import { TicketWorkflowStore } from "../../src/tickets/ticket-workflow-store.ts";

test("feed bootstraps once, globally orders requests, counts multiple questions once and excludes abandoned attempts", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-notification-feed-"));
	const db = new SqliteDatabase(join(root, "db.sqlite"));
	const owner = { username: "owner" };
	let at = "2026-11-14T01:00:00.000Z";
	try {
		await db.initialize();
		await new ProjectStore(db).initialize();
		const tickets = new TicketStore(db);
		await tickets.initialize();
		const metadata = new NotificationStore(db, () => new Date(at));
		await metadata.initialize();
		const jobs = new TicketWorkflowStore(db, () => new Date(at), metadata);
		await jobs.initialize();
		const one = await tickets.insert({ title: "First", description: "", repositoryIds: [] }, at);
		const two = await tickets.insert({ title: "Second", description: "", repositoryIds: [] }, at);
		const agentId = "123e4567-e89b-42d3-a456-426614174010";
		const question = { id: "question", question: "Which?", secret: false, options: ["A", "B"] };
		const agent: AgentThreadRecord = {
			id: agentId,
			projectId: agentId,
			workspaceId: agentId,
			title: "Planner",
			status: "waiting",
			createdAt: at,
			managed: true,
			requests: [
				{
					id: "multi",
					kind: "input",
					description: "Clarify",
					questions: [question, { ...question, id: "other", secret: true }],
				},
				{ id: "approval", kind: "command", description: "Run", questions: [] },
			],
		};
		const threads = new Map([[agentId, agent]]);
		await jobs.save({
			ticketId: two.id,
			phase: "planning",
			state: "running",
			plannerId: agentId,
			mergeAttempts: 0,
		});
		await metadata.sync(`agent:${agentId}`, ["multi", "approval"]);
		at = "2026-11-14T02:00:00.000Z";
		await jobs.save(
			{
				ticketId: one.id,
				phase: "planning",
				state: "idle",
				plan: { revision: 1, text: "Saved plan" },
				mergeAttempts: 0,
			},
			{ status: "in-progress" },
		);
		const feed = new NotificationService(
			metadata,
			{ list: () => tickets.list() },
			{ list: async () => [] },
			{ get: async (id) => threads.get(id) },
			new AccessService({ owner: "owner", origin: "https://forge.test" }),
		);
		await feed.initialize();
		const initial = await feed.list(owner);
		expect(initial.map((item) => item.ticket.id)).toEqual([two.id, two.id, one.id]);
		expect(initial.map((item) => item.kind)).toEqual(["request", "request", "plan"]);
		expect(initial[0]!.request!.questions).toHaveLength(2);
		at = "2026-11-14T03:00:00.000Z";
		await feed.initialize();
		expect(await feed.list(owner)).toEqual(initial);
		await expect(feed.list({ username: "intruder" })).rejects.toThrow("Access denied");
		agent.requests = agent.requests.filter((request) => request.id !== "approval");
		await metadata.sync(`agent:${agentId}`, ["multi"]);
		expect(await feed.list(owner)).toHaveLength(2);
		agent.abandoned = true;
		expect((await feed.list(owner)).map((item) => item.kind)).toEqual(["plan"]);
		agent.abandoned = false;
		await jobs.save({
			ticketId: two.id,
			phase: "implementation",
			state: "running",
			plannerId: agentId,
			implementerId: "123e4567-e89b-42d3-a456-426614174011",
			mergeAttempts: 0,
		});
		expect((await feed.list(owner)).map((item) => item.kind)).toEqual(["plan"]);
		await tickets.archive(one.id, at);
		expect(await feed.list(owner)).toEqual([]);
	} finally {
		await db.close();
		await rm(root, { recursive: true, force: true });
	}
});
