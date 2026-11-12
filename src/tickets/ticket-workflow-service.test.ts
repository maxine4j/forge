import type { AgentView } from "@forge/contracts/agents";
import type { Ticket } from "@forge/contracts/tickets";
import { expect, test, vi } from "vitest";

import { AgentExecutionPool } from "../agents/agent-execution-pool.ts";
import type { ITicketAgents } from "../agents/agent-service.ts";
import { AccessService } from "../auth/access-service.ts";
import { TicketPrompts } from "./ticket-prompts.ts";
import { TicketWorkflowService } from "./ticket-workflow-service.ts";
import type { TicketWorkflowRecord } from "./types.ts";

const actor = { username: "owner" };
const projectId = "123e4567-e89b-42d3-a456-426614174000";
const fixture = () => {
	const jobs = new Map<string, TicketWorkflowRecord>();
	const tickets = new Map<string, Ticket>();
	const views = new Map<string, AgentView>();
	const plans = new Map<string, string>();
	const pool = new AgentExecutionPool();
	const agents = {
		assertRepositoryReady: vi.fn(async () => {}),
		catalogOptions: vi.fn(async () => ({
			models: [
				{
					id: "test-model",
					name: "Test",
					isDefault: true,
					supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
				},
			],
			skills: [],
		})),
		steer: vi.fn<ITicketAgents["steer"]>(async (_actor, id) => structuredClone(views.get(id)!)),
		createTicketThread: vi.fn<ITicketAgents["createTicketThread"]>(
			async (_actor, projectId, title, workspaceId) => {
				const id = `thread-${views.size}`;
				const view: AgentView = {
					thread: {
						id,
						projectId,
						title,
						workspaceId: workspaceId ?? `workspace-${views.size}`,
						createdAt: "2026-11-03T00:00:00.000Z",
						status: "idle",
					},
					items: [],
					requests: [],
					truncated: false,
				};
				views.set(id, view);
				return structuredClone(view);
			},
		),
		dispatch: vi.fn<ITicketAgents["dispatch"]>(async (_actor, id) => {
			pool.claim(id);
			const view = views.get(id)!;
			view.thread.status = "running";
			view.thread.turnId = `turn-${agents.dispatch.mock.calls.length}`;
			return structuredClone(view);
		}),
		plan: vi.fn(async (_actor, id: string) => plans.get(id)),
		get: vi.fn<ITicketAgents["get"]>(async (_actor, id) => structuredClone(views.get(id)!)),
		resume: vi.fn<ITicketAgents["resume"]>(async (_actor, id) => structuredClone(views.get(id)!)),
	};
	const store = {
		boardSummary: async () => [...jobs.values()],
		get: async (id: string) => structuredClone(jobs.get(id)),
		list: async () => [...jobs.values()].map((job) => structuredClone(job)),
		pendingCleanup: async () =>
			[...jobs.values()].filter((job) => tickets.get(job.ticketId)?.status === "done" && !job.workspaceCleaned),
		save: vi.fn(async (job: TicketWorkflowRecord, move?: { status: Ticket["status"] }) => {
			jobs.set(job.ticketId, structuredClone(job));
			if (move) tickets.get(job.ticketId)!.status = move.status;
		}),
	};
	const ticketStore = {
		updateSettings: vi.fn(async (id: string, settings: import("@forge/contracts/agents").AgentSettings) => {
			tickets.get(id)!.executionSettings = structuredClone(settings);
		}),
		get: async (id: string) => structuredClone(tickets.get(id)),
		list: vi.fn(),
		insert: vi.fn(),
		update: vi.fn(),
		archive: vi.fn(async (id: string, archivedAt: string) => {
			tickets.get(id)!.archivedAt ??= archivedAt;
		}),
		move: vi.fn(),
	};
	const merges = {
		candidate: vi.fn(async () => "b".repeat(40)),
		verify: vi.fn(async () => {}),
		merge: vi.fn(async (): Promise<"merged" | "rebase"> => "merged"),
		base: vi.fn(async () => "a".repeat(40)),
	};
	const wake = vi.fn();
	const cleanup = vi.fn(async (_actor: typeof actor, _workspaceId: string, _candidate: string) => {});
	const service = new TicketWorkflowService(
		store,
		ticketStore,
		agents,
		pool,
		merges,
		{ cleanupMerged: cleanup },
		new TicketPrompts(),
		new AccessService({ owner: "owner", origin: "https://forge.example" }),
		wake,
	);
	const create = (id = "FORGE-1") => {
		const ticket: Ticket = {
			id,
			repositoryIds: [projectId],
			title: "Add search",
			description: "Find files",
			status: "backlog",
			createdAt: "2026-11-03T00:00:00.000Z",
		};
		tickets.set(id, ticket);
		return ticket;
	};
	const complete = (id: string, plan?: string) => {
		const view = views.get(id)!;
		view.thread.status = "completed";
		if (plan) plans.set(id, plan);
		else plans.delete(id);
		pool.observe(id, "completed");
	};
	return { service, jobs, tickets, views, pool, agents, merges, create, complete, wake, cleanup };
};

test("Ready requires a first ready repository and dispatch revalidates it", async () => {
	const f = fixture();
	const ticket = f.create();
	ticket.repositoryIds = [];
	await expect(f.service.move(actor, ticket, { status: "todo" })).rejects.toThrow("ticket-conflict");
	expect(f.jobs.size).toBe(0);
	ticket.repositoryIds = [projectId];
	f.agents.assertRepositoryReady.mockRejectedValueOnce(new Error("Repository unavailable"));
	await expect(f.service.move(actor, ticket, { status: "todo" })).rejects.toThrow("ticket-conflict");
	await f.service.move(actor, ticket, { status: "todo" });
	f.agents.assertRepositoryReady.mockRejectedValueOnce(new Error("Repository unavailable"));
	await f.service.tick(actor);
	expect(f.jobs.get(ticket.id)?.state).toBe("setup-failed");
	expect(f.agents.createTicketThread).not.toHaveBeenCalled();
});

test("execution records the first reference and reuses it and its workspace for implementation", async () => {
	const f = fixture();
	const ticket = f.create();
	const first = "123e4567-e89b-42d3-a456-426614174099";
	ticket.repositoryIds = [first, projectId];
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	const job = f.jobs.get(ticket.id)!;
	expect(job.executionRepositoryId).toBe(first);
	expect(f.agents.createTicketThread).toHaveBeenCalledWith(actor, first, `${ticket.id} planning`, undefined, true);
	f.complete(job.plannerId!, "# Plan");
	await f.service.tick(actor);
	await f.service.approve(actor, f.tickets.get(ticket.id)!, 1);
	// Recovery and later phases use the recorded context even if references change underneath them.
	f.tickets.get(ticket.id)!.repositoryIds = [projectId];
	await f.service.recover(actor, ticket.id);
	await f.service.tick(actor);
	expect(f.agents.createTicketThread).toHaveBeenLastCalledWith(
		actor,
		first,
		`${ticket.id} implementation`,
		job.workspaceId,
		true,
	);
	expect(f.jobs.get(ticket.id)?.workspaceId).toBe(job.workspaceId);
	await expect(
		f.service.update(actor, ticket.id, { title: "Locked", description: "", repositoryIds: [] }),
	).rejects.toThrow("ticket-conflict");
});

test("ticket settings validate before saving and each phase snapshots the current selection", async () => {
	const f = fixture();
	const ticket = f.create();
	const settings = { model: "test-model", reasoningEffort: "high", permissions: "full-access" } as const;
	await expect(f.service.settings({ username: "other" }, ticket, settings)).rejects.toThrow();
	await expect(f.service.settings(actor, ticket, { model: "invented" })).rejects.toThrow("unsupported-settings");
	await expect(
		f.service.settings(actor, ticket, { model: "test-model", reasoningEffort: "invented" }),
	).rejects.toThrow("unsupported-settings");
	await f.service.settings(actor, ticket, settings);
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	expect(f.agents.dispatch.mock.calls[0]?.[5]).toEqual(settings);
	await f.service.settings(actor, ticket, {});
	expect(f.agents.dispatch.mock.calls[0]?.[5]).toEqual(settings);
	f.complete(f.jobs.get(ticket.id)!.plannerId!, "# Plan");
	await f.service.tick(actor);
	await f.service.approve(actor, f.tickets.get(ticket.id)!, 1);
	await f.service.tick(actor);
	expect(f.agents.dispatch.mock.calls[1]?.[5]).toEqual({});
	await f.service.settings(actor, ticket, settings);
	const job = f.jobs.get(ticket.id)!;
	await f.service.message(actor, f.tickets.get(ticket.id)!, "Steer", job.turnId);
	expect(f.agents.dispatch.mock.calls[1]?.[5]).toEqual({});
	expect(f.agents.steer).toHaveBeenCalledWith(actor, job.implementerId, job.turnId, "Steer");
});

test("board summary maps execution and attention, checking only the current running agent", async () => {
	const { service, jobs, create, agents } = fixture();
	const ticket = create();
	const base: TicketWorkflowRecord = { ticketId: ticket.id, phase: "planning", state: "queued", mergeAttempts: 0 };
	for (const state of [
		"queued",
		"dispatching",
		"idle",
		"setup-failed",
		"failed",
		"uncertain",
		"merge-queued",
	] as const) {
		jobs.set(ticket.id, { ...base, state });
		const flags = (await service.boardSummary(actor)).get(ticket.id);
		expect(flags).toEqual(
			state === "queued"
				? { agentStatus: "queued" }
				: state === "dispatching"
					? { agentStatus: "working" }
					: ["setup-failed", "failed", "uncertain"].includes(state)
						? { needsAttention: true }
						: {},
		);
	}
	for (const phase of ["planning", "implementation", "rebase"] as const) {
		jobs.set(ticket.id, { ...base, phase, state: "running", plannerId: "planner", implementerId: "implementer" });
		for (const status of ["running", "waiting"] as const) {
			agents.get.mockResolvedValueOnce({ thread: { status } } as AgentView);
			expect((await service.boardSummary(actor)).get(ticket.id)).toEqual(
				status === "waiting" ? { needsAttention: true } : { agentStatus: "working" },
			);
			expect(agents.get).toHaveBeenLastCalledWith(actor, phase === "planning" ? "planner" : "implementer");
		}
	}
	agents.get.mockRejectedValueOnce(new Error("offline"));
	expect((await service.boardSummary(actor)).get(ticket.id)).toEqual({ needsAttention: true });
	for (const phase of ["planning", "review"] as const) {
		jobs.set(ticket.id, { ...base, phase, state: "idle", plan: { revision: 1, text: "Plan" } });
		expect((await service.boardSummary(actor)).get(ticket.id)).toEqual({ needsAttention: true });
	}
	await expect(service.boardSummary({ username: "guest" })).rejects.toThrow("Access denied");
});

test("board shows working during thread setup and preserves setup failure attention", async () => {
	const { service, create, agents } = fixture();
	const ticket = create();
	await service.move(actor, ticket, { status: "todo" });
	let failSetup = () => {};
	const setup = new Promise<never>((_resolve, reject) => {
		failSetup = () => reject(new Error("setup failed"));
	});
	let started = () => {};
	const starting = new Promise<void>((resolve) => {
		started = resolve;
	});
	agents.createTicketThread.mockImplementationOnce(() => {
		started();
		return setup;
	});
	const tick = service.tick(actor);
	await starting;
	expect((await service.boardSummary(actor)).get(ticket.id)).toEqual({ agentStatus: "working" });
	failSetup();
	await tick;
	expect((await service.boardSummary(actor)).get(ticket.id)).toEqual({ needsAttention: true });
});

test.each(["implementation", "rebase"] as const)(
	"%s steering serializes with completion/merge and retains turn and slot accounting",
	async (phase) => {
		const f = fixture();
		const ticket = f.create();
		await f.service.move(actor, ticket, { status: "todo" });
		await f.service.tick(actor);
		let job = f.jobs.get(ticket.id)!;
		await expect(f.service.message(actor, ticket, "Feedback", job.turnId)).rejects.toThrow("ticket-conflict");
		f.complete(job.plannerId!, "Implement tests");
		await f.service.tick(actor);
		await f.service.approve(actor, ticket, 1);
		await f.service.tick(actor);
		job = structuredClone(f.jobs.get(ticket.id)!);
		job.phase = phase;
		f.jobs.set(ticket.id, structuredClone(job));
		await expect(f.service.message({ username: "stranger" }, ticket, "Feedback", job.turnId)).rejects.toThrow();
		await expect(f.service.message(actor, ticket, "Feedback", "stale")).rejects.toThrow("ticket-conflict");
		await f.service.message(actor, ticket, "Focus on tests", job.turnId);
		expect(f.agents.steer).toHaveBeenCalledWith(actor, job.implementerId, job.turnId, "Focus on tests");
		expect(f.jobs.get(ticket.id)).toEqual(job);
		expect(f.pool.activeIds()).toEqual([job.implementerId]);
		f.agents.steer.mockRejectedValueOnce(new Error("Transport lost"));
		await expect(f.service.message(actor, ticket, "Feedback", job.turnId)).rejects.toThrow("Transport lost");
		expect(f.jobs.get(ticket.id)).toEqual(job);
		expect(f.agents.steer).toHaveBeenCalledTimes(2);
		let release = () => {};
		f.agents.steer.mockImplementationOnce(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return structuredClone(f.views.get(job.implementerId!)!);
		});
		const send = f.service.message(actor, ticket, "Before completion", job.turnId);
		await vi.waitFor(() => expect(f.agents.steer).toHaveBeenCalledTimes(3));
		f.complete(job.implementerId!);
		const completion = f.service.tick(actor);
		expect(f.jobs.get(ticket.id)?.state).toBe("running");
		release();
		await send;
		await completion;
		expect(f.jobs.get(ticket.id)?.state).toBe("merge-queued");
		await expect(f.service.message(actor, ticket, "Too late", job.turnId)).rejects.toThrow("ticket-conflict");
		await expect(f.service.message(actor, ticket, "Too late")).rejects.toThrow("ticket-conflict");
		await f.service.tick(actor);
		await expect(f.service.message(actor, ticket, "After merge", job.turnId)).rejects.toThrow("ticket-conflict");
		expect(f.agents.dispatch).toHaveBeenCalledTimes(2);
	},
);

test("archiving serializes with ticket execution and preserves workflow history", async () => {
	const f = fixture();
	const queued = f.create();
	const running = f.create("FORGE-2");
	const archivedAt = "2026-11-04T00:00:00.000Z";
	await f.service.move(actor, queued, { status: "todo" });
	const queuedWorkflow = await f.service.get(actor, queued.id);
	await f.service.move(actor, running, { status: "todo" });
	await Promise.all([f.service.archive(actor, queued, archivedAt), f.service.tick(actor)]);
	expect(f.agents.dispatch).toHaveBeenCalledTimes(1);
	expect(await f.service.get(actor, queued.id)).toEqual(queuedWorkflow);
	await expect(f.service.recover(actor, queued.id)).rejects.toThrow("ticket-conflict");
	await expect(f.service.archive(actor, running, archivedAt)).rejects.toThrow("ticket-conflict");
	expect(f.tickets.get(running.id)?.archivedAt).toBeUndefined();
	const current = await f.service.get(actor, running.id);
	expect(current.state).toBe("running");
	f.complete(current.plannerId!, "Implement search");
	await f.service.tick(actor);
	const idle = await f.service.get(actor, running.id);
	expect(idle).toMatchObject({ state: "idle", plan: { revision: 1 } });
	await f.service.archive(actor, running, archivedAt);
	await expect(f.service.approve(actor, running, 1)).rejects.toThrow("ticket-conflict");
	expect(await f.service.get(actor, running.id)).toEqual(idle);
});

test("ready waits for capacity, starts planning in progress, and approves only the displayed revision", async () => {
	const f = fixture();
	const ticket = f.create();
	for (const id of ["one", "two", "three"]) f.pool.claim(id);
	await f.service.move(actor, ticket, { status: "todo" });
	expect(f.wake).toHaveBeenCalledOnce();
	await f.service.tick(actor);
	expect(ticket.status).toBe("todo");
	expect(f.agents.createTicketThread).not.toHaveBeenCalled();

	f.pool.observe("one", "completed");
	await f.service.tick(actor);
	expect(ticket.status).toBe("in-progress");
	const planning = f.jobs.get(ticket.id)!;
	expect(planning).toMatchObject({ phase: "planning", state: "running", baseSha: "a".repeat(40) });
	const planner = planning.plannerId!;
	f.complete(planner, "# Plan");
	await f.service.tick(actor);
	expect(f.jobs.get(ticket.id)?.plan).toEqual({ revision: 1, text: "# Plan" });
	await f.service.message(actor, ticket, "Include filtering");
	await f.service.tick(actor);
	expect(f.agents.dispatch.mock.calls.at(-1)?.slice(1, 3)).toEqual([planner, "Include filtering"]);
	f.complete(planner, "# Revised plan");
	await f.service.tick(actor);
	await expect(f.service.approve(actor, ticket, 1)).rejects.toThrow("ticket-conflict");
	await f.service.approve(actor, ticket, 2);
	await f.service.tick(actor);
	const implementation = f.jobs.get(ticket.id)!;
	expect(implementation).toMatchObject({
		approvedRevision: 2,
		phase: "implementation",
		state: "running",
		workspaceId: planning.workspaceId,
	});
	expect(implementation.implementerId).not.toBe(planner);
	expect(f.agents.dispatch.mock.calls.at(-1)?.[2]).toContain("# Revised plan");
	expect(f.agents.dispatch.mock.calls.at(-1)?.[2]).not.toContain("FORGE_RESULT");
});

const implement = async (f: ReturnType<typeof fixture>, ticket: Ticket) => {
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	f.complete(f.jobs.get(ticket.id)!.plannerId!, "# Plan");
	await f.service.tick(actor);
	await f.service.approve(actor, ticket, 1);
	await f.service.tick(actor);
	return f.jobs.get(ticket.id)!.implementerId!;
};

test("implementation queues and fast-forwards automatically even when every agent slot is occupied", async () => {
	const f = fixture();
	const ticket = f.create();
	const id = await implement(f, ticket);
	f.complete(id);
	for (const slot of ["one", "two", "three"]) f.pool.claim(slot);
	await f.service.tick(actor);
	await f.service.tick(actor);
	expect(ticket.status).toBe("done");
	expect(f.merges.merge).toHaveBeenCalledOnce();
	expect(f.agents.dispatch).toHaveBeenCalledTimes(2);
	expect(f.wake).toHaveBeenCalledTimes(4);
});

test("cleans up after Done and retries interrupted cleanup without replaying the merge", async () => {
	const f = fixture();
	const ticket = f.create();
	const id = await implement(f, ticket);
	f.complete(id);
	await f.service.tick(actor);
	const { workspaceId, resultSha } = f.jobs.get(ticket.id)!;
	let statusAtCleanup: Ticket["status"] | undefined;
	f.cleanup.mockImplementationOnce(async () => {
		statusAtCleanup = ticket.status;
		throw new Error("Cleanup interrupted");
	});
	await f.service.tick(actor);
	expect(ticket.status).toBe("done");
	expect(statusAtCleanup).toBe("done");
	expect(f.cleanup).toHaveBeenCalledExactlyOnceWith(actor, workspaceId, resultSha);
	await f.service.archive(actor, ticket, "2026-11-04T00:00:00.000Z");
	await f.service.recover(actor);
	await f.service.recover(actor);
	expect(f.cleanup).toHaveBeenCalledTimes(2);
	expect(f.merges.merge).toHaveBeenCalledOnce();
	expect(await f.service.get(actor, ticket.id)).toMatchObject({ state: "idle", workspaceId, resultSha });
});

test("only a divergent fast-forward requests a rebase and recovery does not replay the turn", async () => {
	const f = fixture();
	const ticket = f.create();
	const id = await implement(f, ticket);
	f.merges.merge.mockResolvedValueOnce("rebase");
	f.complete(id);
	await f.service.tick(actor);
	await f.service.tick(actor);
	expect(ticket.status).toBe("in-progress");
	expect(f.jobs.get(ticket.id)).toMatchObject({ phase: "rebase", state: "queued" });
	await f.service.tick(actor);
	expect(f.agents.dispatch.mock.calls.at(-1)?.[2]).toContain("Rebase");
	expect(f.agents.dispatch.mock.calls.at(-1)?.[3]).toEqual({ ticketId: ticket.id, phase: "rebase" });
	f.merges.candidate.mockResolvedValueOnce("c".repeat(40));
	f.complete(id);
	f.jobs.get(ticket.id)!.state = "uncertain";
	await f.service.recover(actor, ticket.id);
	await f.service.tick(actor);
	expect(ticket.status).toBe("done");
	expect(f.merges.merge).toHaveBeenCalledTimes(2);
	expect(f.agents.dispatch).toHaveBeenCalledTimes(3);
});

test("an ambiguous follow-up cannot recover the previous plan as a new revision", async () => {
	const f = fixture();
	const ticket = f.create();
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	const id = f.jobs.get(ticket.id)!.plannerId!;
	f.complete(id, "# Plan");
	await f.service.tick(actor);
	await f.service.message(actor, ticket, "Revise");
	f.agents.dispatch.mockRejectedValueOnce(new Error("Lost connection"));
	await f.service.tick(actor);
	await f.service.recover(actor, ticket.id);
	expect(f.jobs.get(ticket.id)).toMatchObject({ state: "uncertain", plan: { revision: 1 } });
	await expect(f.service.approve(actor, ticket, 1)).rejects.toThrow("ticket-conflict");
});

test.each(["failed", "interrupted"] as const)(
	"%s execution without a turn ID leaves recovery and preserves work",
	async (status) => {
		const f = fixture();
		const ticket = f.create();
		await f.service.move(actor, ticket, { status: "todo" });
		await f.service.tick(actor);
		const job = f.jobs.get(ticket.id)!;
		const saved = { ...job };
		job.state = "uncertain";
		job.turnId = undefined;
		f.agents.get.mockResolvedValueOnce({ thread: { status }, items: [], requests: [], truncated: false } as never);
		await f.service.tick(actor);
		expect(f.jobs.get(ticket.id)).toMatchObject({
			state: "failed",
			workspaceId: saved.workspaceId,
			plannerId: saved.plannerId,
		});
		expect(f.agents.dispatch).toHaveBeenCalledTimes(1);
		expect(f.merges.merge).not.toHaveBeenCalled();
	},
);

test("a completed planning turn without a native plan requires attention", async () => {
	const f = fixture();
	const ticket = f.create();
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	f.complete(f.jobs.get(ticket.id)!.plannerId!);
	await f.service.tick(actor);
	expect(f.jobs.get(ticket.id)?.state).toBe("failed");
	expect(f.jobs.get(ticket.id)?.plan).toBeUndefined();
});

test("worktree setup failure stays visible and can be retried explicitly", async () => {
	const f = fixture();
	const ticket = f.create();
	f.agents.createTicketThread.mockRejectedValueOnce(new Error("Worktree unavailable"));
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	expect(ticket.status).toBe("in-progress");
	expect(f.jobs.get(ticket.id)?.state).toBe("setup-failed");
	await f.service.tick(actor);
	expect(f.agents.dispatch).not.toHaveBeenCalled();
	await f.service.recover(actor, ticket.id);
	await f.service.tick(actor);
	expect(f.jobs.get(ticket.id)?.state).toBe("running");
});

test("uncommitted implementation stays In progress and can receive a plain follow-up", async () => {
	const f = fixture();
	const ticket = f.create();
	const id = await implement(f, ticket);
	f.merges.candidate.mockRejectedValueOnce(new Error("Dirty files"));
	f.complete(id);
	await f.service.tick(actor);
	expect(ticket.status).toBe("in-progress");
	expect(f.jobs.get(ticket.id)?.state).toBe("failed");
	expect(f.merges.merge).not.toHaveBeenCalled();
	await f.service.message(actor, ticket, "Commit the changes");
	await f.service.tick(actor);
	expect(f.agents.dispatch.mock.calls.at(-1)?.slice(1, 3)).toEqual([id, "Commit the changes"]);
});

test("workflow mutations reject nonowners before touching the board", async () => {
	const f = fixture();
	const ticket = f.create();
	await expect(f.service.move({ username: "outsider" }, ticket, { status: "todo" })).rejects.toThrow("Access denied");
	expect(ticket.status).toBe("backlog");
});
