import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import type { AgentRuntimeView } from "../codex/types.ts";
import type { IProjectService } from "../projects/project-service.ts";
import { AgentExecutionPool } from "./agent-execution-pool.ts";
import { AgentService, type IAgentWorkspaces } from "./agent-service.ts";
import { AgentError } from "./errors.ts";
import type { AgentThreadRecord } from "./types.ts";

const owner = { username: "owner" };
const projectId = "123e4567-e89b-42d3-a456-426614174000";
const setup = () => {
	let sequence = 0;
	const records = new Map<string, AgentThreadRecord>();
	const views = new Map<string, AgentRuntimeView>();
	let changed: (id: string) => void = () => {};
	const id = () => `123e4567-e89b-42d3-a456-${String(++sequence).padStart(12, "0")}`;
	const createdAt = "2026-11-03T00:00:00.000Z";
	const projects: IProjectService = {
		get: vi.fn<IProjectService["get"]>(async () => ({
			id: projectId,
			name: "Project",
			status: "ready",
			createdAt,
		})),
		create: vi.fn(),
		list: vi.fn(),
		retry: vi.fn(),
		recover: vi.fn(),
	};
	const workspaces: IAgentWorkspaces = {
		tree: vi.fn(async () => ({
			path: "",
			truncated: false,
			entries: [{ name: "README.md", path: "README.md", kind: "file" as const, lastChangedAt: createdAt }],
		})),
		create: vi.fn<IAgentWorkspaces["create"]>(async () => ({
			id: id(),
			projectId,
			name: "Chat",
			status: "ready",
			branch: "forge/workspace/test",
			createdAt,
		})),
		resolve: vi.fn<IAgentWorkspaces["resolve"]>(async (_actor, workspaceId) => ({
			path: `/data/worktrees/${workspaceId}`,
			workspace: {
				id: workspaceId,
				projectId,
				name: "Chat",
				status: "ready",
				branch: "forge/workspace/test",
				createdAt,
			},
		})),
	};
	const client = {
		options: vi.fn(async () => ({
			models: [{ id: "test-model", name: "Test model", isDefault: true }],
			skills: [],
		})),
		files: vi.fn(async () => ["src/main.ts"]),
		start: vi.fn(async () => {
			const key = `codex-${views.size + 1}`;
			views.set(key, { status: "idle", items: [], requests: [], truncated: false });
			return key;
		}),
		read: (key: string) => structuredClone(views.get(key)!),
		resume: vi.fn(async (key: string) => {
			const view = views.get(key)!;
			view.status = "completed";
			return view;
		}),
		send: vi.fn(async (key: string) => {
			const view = views.get(key)!;
			if (!view) throw new AgentError("agent-unavailable");
			view.status = "running";
			view.turnId = "turn";
		}),
		interrupt: vi.fn(async () => {}),
		reply: vi.fn(),
		subscribe: (listener: (key: string) => void) => {
			changed = listener;
			return () => {};
		},
	};
	const store = {
		insert: async (record: AgentThreadRecord) => {
			records.set(record.id, structuredClone(record));
		},
		update: async (record: AgentThreadRecord) => {
			records.set(record.id, structuredClone(record));
		},
		get: async (key: string) => structuredClone(records.get(key)),
		list: async () => [...records.values()],
		recover: async () => {},
	};
	const service = new AgentService(
		store,
		client,
		workspaces,
		projects,
		new AccessService({ owner: "owner", origin: "https://forge.example" }),
		id,
		() => new Date(createdAt),
		new AgentExecutionPool(),
	);
	return { service, client, workspaces, records, views, changed: (key: string) => changed(key) };
};
test("settings persist per chat and discovery always resolves the owned worktree", async () => {
	const { service, client, workspaces, records } = setup();
	const { thread } = await service.create(owner, projectId, "Configured");
	expect(await service.options(owner, thread.id)).toMatchObject({ models: [{ id: "test-model" }] });
	expect(await service.files(owner, thread.id, "main")).toEqual(["src/main.ts"]);
	expect(await service.files(owner, thread.id, "")).toEqual(["README.md"]);
	expect(client.files).toHaveBeenCalledWith(`/data/worktrees/${thread.workspaceId}`, "main");
	await service.send(owner, thread.id, "Work", { model: "test-model", permissions: "approve-for-me" });
	expect(records.get(thread.id)).toMatchObject({ model: "test-model", permissions: "approve-for-me" });
	expect(client.send).toHaveBeenCalledWith(expect.any(String), `/data/worktrees/${thread.workspaceId}`, "Work", {
		model: "test-model",
		permissions: "approve-for-me",
	});
	expect(workspaces.resolve).toHaveBeenCalledWith(owner, thread.workspaceId);
	await expect(service.options({ username: "outsider" }, thread.id)).rejects.toThrow();
	await expect(service.files(owner, thread.id, "x".repeat(501))).rejects.toThrow("invalid-request");
	await service.shutdown();
});
test("threads have independent verified worktrees and may execute concurrently; same-thread duplicate sends conflict", async () => {
	const { service, client, workspaces } = setup();
	const first = await service.create(owner, projectId, "First");
	const second = await service.create(owner, projectId, "Second");
	expect(first.thread.workspaceId).not.toBe(second.thread.workspaceId);
	await Promise.all([service.send(owner, first.thread.id, "One"), service.send(owner, second.thread.id, "Two")]);
	expect(client.send).toHaveBeenCalledTimes(2);
	expect(workspaces.resolve).toHaveBeenCalledWith(owner, first.thread.workspaceId);
	await expect(service.send(owner, first.thread.id, "Duplicate")).rejects.toThrow("agent-conflict");
	expect(JSON.stringify(await service.list(owner, projectId))).not.toContain("codex-");
	await service.shutdown();
});
test("empty chats survive restart without depending on an unpersisted Codex thread", async () => {
	const { service, client, records } = setup();
	const { thread } = await service.create(owner, projectId, "Empty");
	expect(client.start).not.toHaveBeenCalled();
	expect(records.get(thread.id)).toMatchObject({ status: "idle" });
	expect(records.get(thread.id)?.codexId).toBeUndefined();
	expect((await service.resume(owner, thread.id)).thread.status).toBe("idle");
	expect(client.resume).not.toHaveBeenCalled();
	await service.shutdown();
});

test("ordinary service sends enforce the public message bound", async () => {
	const { service, client } = setup();
	const { thread } = await service.create(owner, projectId, "Chat");
	await expect(service.send(owner, thread.id, "x".repeat(8001))).rejects.toThrow("invalid-request");
	expect(client.start).not.toHaveBeenCalled();
	await service.shutdown();
});

test("scheduler prompts can carry a full approved plan beyond the public message bound", async () => {
	const { service, client } = setup();
	const { thread } = await service.createTicketThread(owner, projectId, "Ticket");
	await service.dispatch(owner, thread.id, "x".repeat(28000));
	expect(client.send).toHaveBeenCalledOnce();
	await service.shutdown();
});

test("queued ticket followups resume persisted completed conversations without a browser visit", async () => {
	const { service, client, records, views } = setup();
	const { thread } = await service.createTicketThread(owner, projectId, "Persisted ticket");
	Object.assign(records.get(thread.id)!, { status: "completed", codexId: "persisted" });
	client.resume.mockImplementation(async (key) => {
		const view: AgentRuntimeView = { status: "completed", items: [], requests: [], truncated: false };
		views.set(key, view);
		return view;
	});
	await expect(service.dispatch(owner, thread.id, "Queued feedback")).resolves.toMatchObject({
		thread: { status: "running" },
	});
	expect(client.resume).toHaveBeenCalledOnce();
	expect(client.send).toHaveBeenCalledOnce();
	Object.assign(records.get(thread.id)!, { status: "completed" });
	views.delete("persisted");
	await expect(service.dispatch(owner, thread.id, "Followup after runtime reset")).resolves.toMatchObject({
		thread: { status: "running" },
	});
	expect(client.resume).toHaveBeenCalledTimes(2);
	await service.shutdown();
});

test("a fourth chat cannot start until a running chat completes", async () => {
	const { service, records, views, changed } = setup();
	const threads = await Promise.all([1, 2, 3, 4].map((n) => service.create(owner, projectId, `Chat ${n}`)));
	for (const thread of threads.slice(0, 3)) await service.send(owner, thread.thread.id, "Work");
	await expect(service.send(owner, threads[3]!.thread.id, "Work")).rejects.toThrow("agent-capacity");
	const codexId = records.get(threads[0]!.thread.id)!.codexId!;
	views.get(codexId)!.status = "completed";
	changed(codexId);
	await service.get(owner, threads[0]!.thread.id);
	await service.send(owner, threads[3]!.thread.id, "Work");
	await service.shutdown();
});

test("ticket phases retain one worktree, use separate Codex contexts and reject unmanaged dispatch", async () => {
	const { service, workspaces } = setup();
	const planning = await service.createTicketThread(owner, projectId, "Ticket planning");
	const implementing = await service.createTicketThread(
		owner,
		projectId,
		"Ticket implementation",
		planning.thread.workspaceId,
	);
	expect(workspaces.create).toHaveBeenCalledOnce();
	expect(implementing.thread.workspaceId).toBe(planning.thread.workspaceId);
	await expect(service.send(owner, planning.thread.id, "Bypass queue")).rejects.toThrow("agent-conflict");
	await service.dispatch(owner, planning.thread.id, "Plan");
	expect((await service.list(owner, projectId)).map((thread) => thread.id)).not.toContain(planning.thread.id);
	await service.shutdown();
});
test("shutdown drains an accepted chat creation before storage may close", async () => {
	const { service, workspaces } = setup();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const create = vi.mocked(workspaces.create).getMockImplementation()!;
	vi.mocked(workspaces.create).mockImplementation(async (...args) => {
		await gate;
		return create(...args);
	});
	const creation = service.create(owner, projectId, "Pending");
	let stopped = false;
	const shutdown = service.shutdown().then(() => {
		stopped = true;
	});
	try {
		await Promise.resolve();
		await Promise.resolve();
		expect(stopped).toBe(false);
	} finally {
		release();
		await creation;
		await shutdown;
	}
});
test("connection loss requires explicit reconciliation; uncertain turns are never sent again", async () => {
	const { service, client, records, views, changed } = setup();
	const { thread } = await service.create(owner, projectId, "Chat");
	await service.send(owner, thread.id, "Work");
	const codexId = records.get(thread.id)!.codexId!;
	views.get(codexId)!.status = "uncertain";
	changed(codexId);
	expect((await service.get(owner, thread.id)).thread.status).toBe("uncertain");
	await expect(service.send(owner, thread.id, "Retry")).rejects.toThrow("agent-conflict");
	await service.resume(owner, thread.id);
	expect(client.resume).toHaveBeenCalledOnce();
	expect(client.send).toHaveBeenCalledOnce();
	await service.send(owner, thread.id, "Continue");
	expect(client.send).toHaveBeenCalledTimes(2);
	await service.shutdown();
});
test("authorization precedes storage/workspace/runtime access; failed worktree verification prevents execution", async () => {
	const { service, workspaces, client } = setup();
	await expect(service.create({ username: "outsider" }, projectId, "Chat")).rejects.toThrow("Access denied");
	expect(workspaces.create).not.toHaveBeenCalled();
	const { thread } = await service.create(owner, projectId, "Chat");
	vi.mocked(workspaces.resolve).mockRejectedValue(new Error("Invalid worktree"));
	await expect(service.send(owner, thread.id, "Work")).rejects.toThrow();
	expect(client.send).not.toHaveBeenCalled();
	for (const operation of [
		() => service.get({ username: "outsider" }, thread.id),
		() => service.reply({ username: "outsider" }, thread.id, { requestId: "x", decision: "accept" }),
		() => service.interrupt({ username: "outsider" }, thread.id),
	])
		await expect(operation()).rejects.toThrow("Access denied");
	await service.shutdown();
});
