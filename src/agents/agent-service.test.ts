import type { AgentOptions } from "@forge/contracts/agents";
import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import type { AgentRuntimeView, ExecutionReconciliation } from "../codex/types.ts";
import type { IProjectService } from "../projects/project-service.ts";
import { AgentExecutionPool } from "./agent-execution-pool.ts";
import { AgentService, type IAgentWorkspaces } from "./agent-service.ts";
import { AgentError } from "./errors.ts";
import type { AgentThreadRecord } from "./types.ts";

const owner = { username: "owner" };
const projectId = "123e4567-e89b-42d3-a456-426614174000";
const setup = (defaults: () => Pick<AgentOptions, "defaultModel" | "defaultReasoningEffort"> = () => ({})) => {
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
		list: vi.fn(async () => [{ id: projectId, name: "Project", status: "ready" as const, createdAt }]),
		retry: vi.fn(),
		recover: vi.fn(),
	};
	const workspaces: IAgentWorkspaces = {
		get: vi.fn<IAgentWorkspaces["get"]>(async (_actor, workspaceId) => ({
			id: workspaceId,
			projectId,
			name: "Chat",
			status: "ready",
			branch: "forge/workspace/test",
			createdAt,
		})),
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
		reconcile: vi.fn<(key?: string) => Promise<ExecutionReconciliation>>(async (key) => {
			const view = key ? views.get(key) : undefined;
			return view && ["running", "waiting"].includes(view.status)
				? { state: "active" as const, turnId: view.turnId! }
				: { state: "inactive" as const };
		}),
		steer: vi.fn(async (_id: string, _turnId: string, _text: string) => {}),
		options: vi.fn(async () => ({
			models: [
				{
					id: "test-model",
					name: "Test model",
					isDefault: true,
					supportedReasoningEfforts: [
						{ reasoningEffort: "high", description: "High" },
						{ reasoningEffort: "medium", description: "Medium" },
					],
					defaultReasoningEffort: "medium",
				},
				{
					id: "alternate",
					name: "Alternate",
					isDefault: false,
					supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Low" }],
				},
			],
			skills: [],
		})),
		files: vi.fn(async () => ["src/main.ts"]),
		start: vi.fn(async () => {
			const key = `codex-${views.size + 1}`;
			views.set(key, { status: "idle", items: [], requests: [], truncated: false });
			return key;
		}),
		read: (key: string) => structuredClone(views.get(key)!),
		loadHistory: vi.fn(async (key: string): Promise<AgentRuntimeView> => {
			const view: AgentRuntimeView = {
				status: "completed",
				items: [{ id: "answer", role: "assistant", text: "Completed work" }],
				requests: [],
				truncated: false,
			};
			views.set(key, view);
			return view;
		}),
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
		interrupt: vi.fn(async (_id: string, _turnId: string) => {}),
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
	const pool = new AgentExecutionPool();
	const service = new AgentService(
		store,
		client,
		workspaces,
		projects,
		new AccessService({ owner: "owner", origin: "https://forge.example" }),
		id,
		() => new Date(createdAt),
		pool,
		defaults,
	);
	return { service, client, store, workspaces, records, views, pool, changed: (key: string) => changed(key) };
};

test("repeated stop reconciles uncertain slots and reports acknowledgments as unresolved", async () => {
	const f = setup();
	const { thread } = await f.service.create(owner, projectId, "Chat");
	await f.service.send(owner, thread.id, "Work");
	f.records.get(thread.id)!.status = "uncertain";
	expect(await f.service.stopAll(owner)).toEqual({ requested: 1, recovered: 0, failed: 1 });
	f.views.get("codex-1")!.status = "interrupted";
	expect(await f.service.stopAll(owner)).toEqual({ requested: 0, recovered: 1, failed: 0 });
	expect(f.records.get(thread.id)?.status).toBe("interrupted");
	expect(await f.service.stopAll(owner)).toEqual({ requested: 0, recovered: 0, failed: 0 });
});

test("startup recovers unidentified creation only with lifecycle evidence and never dispatches it", async () => {
	const f = setup();
	const { thread } = await f.service.create(owner, projectId, "Ambiguous");
	f.records.get(thread.id)!.status = "uncertain";
	await f.service.seed(owner);
	f.client.reconcile.mockResolvedValueOnce({ state: "unavailable" });
	await f.service.recover(owner);
	expect(f.records.get(thread.id)?.status).toBe("uncertain");
	await f.service.recover(owner);
	expect(f.records.get(thread.id)?.status).toBe("interrupted");
	expect(f.client.start).not.toHaveBeenCalled();
	expect(f.client.send).not.toHaveBeenCalled();
	expect(f.records.get(thread.id)?.workspaceId).toBe(thread.workspaceId);
});

test("persistence failure retains a recovered reservation for retry", async () => {
	const f = setup();
	const { thread } = await f.service.create(owner, projectId, "Chat");
	await f.service.send(owner, thread.id, "Work");
	f.views.get("codex-1")!.status = "interrupted";
	const update = vi.spyOn(f.store, "update").mockRejectedValueOnce(new Error("disk unavailable"));
	expect(await f.service.stopAll(owner)).toEqual({ requested: 0, recovered: 0, failed: 1 });
	expect(f.records.get(thread.id)?.status).toBe("running");
	update.mockRestore();
	expect(await f.service.stopAll(owner)).toEqual({ requested: 0, recovered: 1, failed: 0 });
});

test("standalone submissions cannot race an ongoing stop", async () => {
	const f = setup();
	const running = await f.service.create(owner, projectId, "Running");
	const idle = await f.service.create(owner, projectId, "Idle");
	await f.service.send(owner, running.thread.id, "Work");
	const entered = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	f.client.reconcile.mockImplementationOnce(async () => {
		entered.resolve();
		await proceed.promise;
		return { state: "active", turnId: "turn" };
	});
	const stop = f.service.stopAll(owner);
	await entered.promise;
	await expect(f.service.send(owner, idle.thread.id, "Race")).rejects.toThrow("agent-capacity");
	proceed.resolve();
	await stop;
	expect(f.client.send).toHaveBeenCalledTimes(1);
	await f.service.send(owner, idle.thread.id, "Explicit submission after stop");
	expect(f.client.send).toHaveBeenCalledTimes(2);
});

test("completed managed conversations load history and saved context after worktree removal", async () => {
	const f = setup();
	const { thread } = await f.service.createTicketThread(owner, projectId, "Implementation");
	await f.service.dispatch(owner, thread.id, "Implement", { ticketId: "TASK-1", phase: "implementation" });
	const codexId = f.records.get(thread.id)!.codexId!;
	Object.assign(f.views.get(codexId)!, { status: "completed", contextWindow: { used: 4200, max: 128000 } });
	f.changed(codexId);
	await expect(f.service.get(owner, thread.id)).resolves.toMatchObject({
		contextWindow: { used: 4200, max: 128000 },
	});
	expect(f.records.get(thread.id)?.contextWindow).toEqual({ used: 4200, max: 128000 });
	f.views.get(codexId)!.contextWindow = undefined;
	const { workspace } = await f.workspaces.resolve(owner, thread.workspaceId);
	vi.mocked(f.workspaces.get).mockResolvedValueOnce({ ...workspace, status: "archived" });
	vi.mocked(f.workspaces.resolve).mockClear();
	await expect(f.service.resume(owner, thread.id)).resolves.toMatchObject({
		thread: { status: "completed" },
		items: [{ text: "Completed work" }],
		contextWindow: { used: 4200, max: 128000 },
	});
	expect(f.client.loadHistory).toHaveBeenCalledWith(codexId);
	expect(f.client.resume).not.toHaveBeenCalled();
	expect(f.workspaces.resolve).not.toHaveBeenCalled();
});

test("ticket steering checks authorization, ownership and active turn without claiming another slot", async () => {
	const f = setup();
	const { thread } = await f.service.createTicketThread(owner, projectId, "Implementation");
	await f.service.dispatch(owner, thread.id, "Implement", { ticketId: "TASK-1", phase: "implementation" });
	await expect(f.service.steer({ username: "stranger" }, thread.id, "turn", "Feedback")).rejects.toThrow();
	await expect(f.service.steer(owner, thread.id, "stale", "Feedback")).rejects.toThrow("agent-conflict");
	await expect(f.service.steer(owner, thread.id, "turn", "   ")).rejects.toThrow("invalid-request");
	const before = f.records.get(thread.id);
	await f.service.steer(owner, thread.id, "turn", "Focus on tests");
	expect(f.client.steer).toHaveBeenCalledWith(
		before!.codexId,
		"turn",
		"Focus on tests",
		`/data/worktrees/${before!.workspaceId}`,
	);
	expect(f.records.get(thread.id)).toEqual(before);
	expect(f.client.send).toHaveBeenCalledTimes(1);
	vi.mocked(f.workspaces.resolve).mockResolvedValueOnce({
		path: "/wrong",
		workspace: { ...(await f.workspaces.resolve(owner, thread.workspaceId)).workspace, projectId: "other" },
	});
	await expect(f.service.steer(owner, thread.id, "turn", "Feedback")).rejects.toThrow("agent-conflict");
	vi.mocked(f.workspaces.resolve).mockRejectedValueOnce(new Error("workspace unavailable"));
	await expect(f.service.steer(owner, thread.id, "turn", "Feedback")).rejects.toThrow("workspace unavailable");
	expect(f.client.steer).toHaveBeenCalledTimes(1);
	f.client.steer.mockRejectedValueOnce(new AgentError("agent-unavailable"));
	await expect(f.service.steer(owner, thread.id, "turn", "Feedback")).rejects.toThrow("agent-unavailable");
	expect(f.client.steer).toHaveBeenCalledTimes(2);
});
test("settings persist per chat and discovery always resolves the owned worktree", async () => {
	const { service, client, workspaces, records } = setup();
	const { thread } = await service.create(owner, projectId, "Configured");
	expect(await service.options(owner, thread.id)).toMatchObject({
		models: [{ id: "test-model" }, { id: "alternate" }],
	});
	expect(await service.files(owner, thread.id, "main")).toEqual(["src/main.ts"]);
	expect(await service.files(owner, thread.id, "")).toEqual(["README.md"]);
	expect(client.files).toHaveBeenCalledWith(`/data/worktrees/${thread.workspaceId}`, "main");
	await service.send(owner, thread.id, "Work", { model: "test-model", permissions: "approve-for-me" });
	expect(records.get(thread.id)).toMatchObject({ model: "test-model", permissions: "approve-for-me" });
	expect(client.send).toHaveBeenCalledWith(
		expect.any(String),
		`/data/worktrees/${thread.workspaceId}`,
		"Work",
		{
			model: "test-model",
			reasoningEffort: "medium",
			permissions: "approve-for-me",
		},
		{ projectId, phase: "chat" },
	);
	expect(workspaces.resolve).toHaveBeenCalledWith(owner, thread.workspaceId);
	await expect(service.options({ username: "outsider" }, thread.id)).rejects.toThrow();
	await expect(service.files(owner, thread.id, "x".repeat(501))).rejects.toThrow("invalid-request");
	await service.shutdown();
});
test("stop all interrupts both chat and ticket turns and reports individual failures", async () => {
	const { service, client, views } = setup();
	const chat = await service.create(owner, projectId, "Chat");
	const ticket = await service.createTicketThread(owner, projectId, "Ticket");
	await service.create(owner, projectId, "Idle");
	await service.send(owner, chat.thread.id, "Work");
	await service.dispatch(owner, ticket.thread.id, "Plan");
	client.interrupt.mockRejectedValueOnce(new AgentError("agent-unavailable")).mockImplementationOnce(async () => {
		views.get("codex-2")!.status = "interrupted";
	});
	await expect(service.stopAll({ username: "outsider" })).rejects.toThrow("Access denied");
	expect(client.interrupt).not.toHaveBeenCalled();
	expect(await service.stopAll(owner)).toEqual({ requested: 1, recovered: 1, failed: 1 });
	expect(client.interrupt.mock.calls).toEqual([
		["codex-1", "turn"],
		["codex-2", "turn"],
	]);
	expect((await service.get(owner, ticket.thread.id)).thread.status).toBe("interrupted");
	await service.shutdown();
});

test("a stop during ticket setup holds the turn before sending it to Codex", async () => {
	const { service, workspaces, client } = setup();
	const { thread } = await service.createTicketThread(owner, projectId, "Ticket");
	const resolving = Promise.withResolvers<void>();
	const proceed = Promise.withResolvers<void>();
	const resolve = workspaces.resolve;
	vi.mocked(workspaces.resolve).mockImplementationOnce(async (actor, id) => {
		resolving.resolve();
		await proceed.promise;
		return resolve(actor, id);
	});
	let allowed = true;
	const dispatch = service.dispatch(
		owner,
		thread.id,
		"Plan",
		{ ticketId: "TASK-1", phase: "planning" },
		() => allowed,
	);
	const held = expect(dispatch).rejects.toThrow("agent-capacity");
	await resolving.promise;
	allowed = false;
	const stopped = service.stopAll(owner);
	proceed.resolve();
	await held;
	expect(await stopped).toEqual({ requested: 0, recovered: 0, failed: 0 });
	expect(client.send).not.toHaveBeenCalled();
	expect((await service.get(owner, thread.id)).thread.status).toBe("idle");
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
test("thinking validates against the runtime catalog before dispatch and persists with the thread", async () => {
	const { service, client, records, workspaces } = setup();
	const { thread } = await service.create(owner, projectId, "Thinking");
	await service.catalogOptions(owner);
	expect(workspaces.resolve).not.toHaveBeenCalled();
	await expect(service.catalogOptions({ username: "other" })).rejects.toThrow();
	await expect(service.send(owner, thread.id, "Draft", { model: "invented" })).rejects.toThrow(
		"unsupported-settings",
	);
	await expect(service.send(owner, thread.id, "Draft", { reasoningEffort: "invented" })).rejects.toThrow(
		"unsupported-settings",
	);
	expect(client.start).not.toHaveBeenCalled();
	await service.send(owner, thread.id, "Draft", { reasoningEffort: "high" });
	expect(records.get(thread.id)?.reasoningEffort).toBe("high");
	expect(client.send).toHaveBeenLastCalledWith(
		expect.any(String),
		expect.any(String),
		"Draft",
		expect.objectContaining({ reasoningEffort: "high" }),
		expect.anything(),
	);
	await service.shutdown();
});

test("existing chats and tickets inherit updated defaults without saving them as overrides", async () => {
	const defaults = { defaultModel: "test-model", defaultReasoningEffort: "high" };
	const { service, client, records } = setup(() => defaults);
	const { thread: chat } = await service.create(owner, projectId, "Chat");
	const { thread: planner } = await service.createTicketThread(owner, projectId, "Ticket");
	const ticket = { ticketId: "TASK-1", phase: "planning" } as const;
	const expectTurn = (text: string, model: string, reasoningEffort?: string) => {
		expect(client.send).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.any(String),
			text,
			{ model, reasoningEffort, permissions: undefined },
			expect.anything(),
		);
	};
	await service.send(owner, chat.id, "First message", {});
	expectTurn("First message", "test-model", "high");
	await service.dispatch(owner, planner.id, "First plan", ticket);
	expectTurn("First plan", "test-model", "high");
	defaults.defaultModel = "alternate";
	defaults.defaultReasoningEffort = "low";
	await service.resume(owner, chat.id);
	await service.resume(owner, planner.id);
	await service.send(owner, chat.id, "Next message", {});
	expectTurn("Next message", "alternate", "low");
	await service.dispatch(owner, planner.id, "Next plan", ticket);
	expectTurn("Next plan", "alternate", "low");
	for (const id of [chat.id, planner.id]) {
		expect(records.get(id)?.model).toBeUndefined();
		expect(records.get(id)?.reasoningEffort).toBeUndefined();
	}
	await service.resume(owner, chat.id);
	await service.send(owner, chat.id, "Different model", { model: "test-model" });
	expectTurn("Different model", "test-model", "medium");
	await service.resume(owner, chat.id);
	await service.send(owner, chat.id, "Explicit settings", { model: "test-model", reasoningEffort: "high" });
	expectTurn("Explicit settings", "test-model", "high");
	await service.resume(owner, chat.id);
	defaults.defaultModel = "retired-model";
	await service.send(owner, chat.id, "Fallback model", {});
	expectTurn("Fallback model", "test-model", "medium");
	await service.shutdown();
});

test("unsupported ticket overrides release the reservation before starting a turn", async () => {
	const { service, client, pool } = setup(() => ({ defaultModel: "alternate" }));
	const { thread } = await service.createTicketThread(owner, projectId, "Ticket", undefined, true);
	expect(pool.activeIds()).toEqual([thread.id]);
	await expect(
		service.dispatch(owner, thread.id, "Plan", { ticketId: "TASK-1", phase: "planning" }, undefined, {
			reasoningEffort: "high",
		}),
	).rejects.toThrow("unsupported-settings");
	expect(pool.activeIds()).toEqual([]);
	expect(client.start).not.toHaveBeenCalled();
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

test("ticket thread setup reserves capacity before allocating a worktree and releases it on failure", async () => {
	const { service, workspaces } = setup();
	const chats = await Promise.all([1, 2, 3].map((n) => service.create(owner, projectId, `Chat ${n}`)));
	for (const chat of chats.slice(0, 2)) await service.send(owner, chat.thread.id, "Work");
	const pending = Promise.withResolvers<Awaited<ReturnType<IAgentWorkspaces["create"]>>>();
	vi.mocked(workspaces.create).mockReturnValueOnce(pending.promise);
	const planning = service.createTicketThread(owner, projectId, "Ticket planning", undefined, true);
	await expect(service.send(owner, chats[2]!.thread.id, "Work")).rejects.toThrow("agent-capacity");
	pending.reject(new Error("Workspace unavailable"));
	await expect(planning).rejects.toThrow("Workspace unavailable");
	await service.send(owner, chats[2]!.thread.id, "Work");
	await expect(service.createTicketThread(owner, projectId, "Queued planning", undefined, true)).rejects.toThrow(
		"agent-capacity",
	);
	expect(workspaces.create).toHaveBeenCalledTimes(4);
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
