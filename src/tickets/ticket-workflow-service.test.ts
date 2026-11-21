import type { AgentView } from "@forge/contracts/agents";
import type { ModelProvider } from "@forge/contracts/model-providers";
import type { TaskAgent, TaskAgentModel } from "@forge/contracts/task-agents";
import type { Ticket } from "@forge/contracts/tickets";
import { expect, test, vi } from "vitest";

import { AgentExecutionTracker } from "../agents/agent-execution-tracker.ts";
import type { ITicketAgents } from "../agents/agent-service.ts";
import { AgentError } from "../agents/errors.ts";
import { AccessService } from "../auth/access-service.ts";
import { ModelProviderService, type IModelProviderService } from "../model-providers/model-provider-service.ts";
import { TaskAgentService, type ITaskAgents } from "../task-agents/task-agent-service.ts";
import { TicketPrompts } from "./ticket-prompts.ts";
import { TicketWorkflowService } from "./ticket-workflow-service.ts";
import type { TicketWorkflowRecord } from "./types.ts";

const actor = { username: "owner" };

function namedFixture(dispatchMode?: Parameters<typeof fixture>[0], quotaExhausted?: () => Promise<boolean>) {
	const planner: ModelProvider = {
		id: "123e4567-e89b-42d3-a456-426614174001",
		name: "OpenAI",
		kind: "openai",
		retired: false,
		maxConcurrentAgents: 1,
	};
	const implementer: ModelProvider = {
		id: "123e4567-e89b-42d3-a456-426614174002",
		name: "Local",
		kind: "ollama",
		endpoint: "http://local/v1",
		retired: false,
		maxConcurrentAgents: 1,
	};
	const records = new Map([planner, implementer].map((p) => [p.id, p]));
	const providers = new ModelProviderService(
		{
			list: async () => [...records.values()],
			get: async (id) => records.get(id),
			save: async (p) => {
				records.set(p.id, p);
			},
		},
		new AccessService({ owner: "owner", origin: "https://forge.example" }),
		() => planner.id,
		async (p) => ({
			models:
				p.kind === "ollama"
					? [{ id: p.model, name: p.model, isDefault: true }]
					: ["test-model", "other-model"].map((id) => ({
							id,
							name: id,
							isDefault: id === "test-model",
							supportedReasoningEfforts: ["low", "high"].map((reasoningEffort) => ({
								reasoningEffort,
								description: reasoningEffort,
							})),
						})),
			skills: [],
			...(p.kind === "ollama" ? { supportsAutoReview: false as const } : {}),
		}),
	);
	const recordsById = new Map<string, TaskAgent>();
	const taskAgents = new TaskAgentService(
		{
			list: async () => [...recordsById.values()],
			get: async (id) => recordsById.get(id),
			save: async (agent) => {
				recordsById.set(agent.id, agent);
			},
			retire: async (id) => {
				const agent = recordsById.get(id);
				if (!agent || agent.retired) return false;
				recordsById.set(id, { ...agent, retired: true });
				return true;
			},
		},
		providers,
		new AccessService({ owner: "owner", origin: "https://forge.example" }),
		() => `123e4567-e89b-42d3-a456-${String(recordsById.size + 100).padStart(12, "0")}`,
		() => 0,
	);
	const f = fixture(dispatchMode, providers, taskAgents, quotaExhausted);
	f.agents.catalogOptions.mockImplementation(async (_actor, id) => {
		const call = f.agents.createTicketThread.mock.calls.find((call) => call[2] === f.views.get(id!)?.thread.title);
		const snapshot = call?.[5];
		return providers.snapshotOptions(actor, snapshot?.configuration ?? { kind: "openai" });
	});
	const addAgent = (
		name: string,
		models: TaskAgentModel[] = [{ providerId: planner.id, model: "test-model" }],
		maxConcurrentTickets?: number,
	) => taskAgents.save(actor, { name, models, maxConcurrentTickets });
	const ready = async (ticket: Ticket, planner: TaskAgent, implementer = planner, skipPlanning = false) => {
		await f.service.settings(actor, ticket, {
			plannerAgentId: planner.id,
			implementerAgentId: implementer.id,
			skipPlanning,
		});
		await f.service.move(actor, ticket, { status: "todo" });
	};
	return { ...f, planner, implementer, providers, taskAgents, addAgent, ready };
}

test("ticket avatars follow the workflow phase and retain retired assignees", async () => {
	const f = namedFixture();
	const planner = await f.addAgent("Planner");
	const implementer = await f.addAgent("Implementer");
	const ticket = f.create();
	await f.service.settings(actor, ticket, { plannerAgentId: planner.id, implementerAgentId: implementer.id });
	const assigned = () => f.service.capabilities(actor, f.tickets.get(ticket.id)!);
	expect((await assigned()).assignee).toEqual({ name: planner.name, avatarColour: planner.avatarColour });
	await f.service.move(actor, ticket, { status: "todo" });
	const job = f.jobs.get(ticket.id)!;
	f.jobs.set(ticket.id, { ...job, phase: "implementation", state: "running" });
	await f.taskAgents.save(
		actor,
		{ name: implementer.name, models: implementer.models, avatarColour: "Teal" },
		implementer.id,
	);
	await f.taskAgents.retire(actor, implementer.id);
	expect((await assigned()).assignee).toEqual({ name: implementer.name, avatarColour: "Teal" });
});

test("independent assignees pin model and provider for feedback, recovery and rebase", async () => {
	const f = namedFixture();
	const planner = await f.taskAgents.save(actor, {
		name: "Planner",
		models: [{ providerId: f.planner.id, model: "test-model", reasoningEffort: "high" }],
	});
	const implementer = await f.taskAgents.save(actor, {
		name: "Implementer",
		models: [{ providerId: f.implementer.id, model: "local" }],
	});
	const ticket = f.create();
	await f.service.settings(actor, ticket, { plannerAgentId: planner.id, implementerAgentId: planner.id });
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	const plannerId = f.jobs.get(ticket.id)!.plannerId!;
	await f.service.settings(actor, ticket, { plannerAgentId: planner.id, implementerAgentId: implementer.id });
	await f.taskAgents.retire(actor, planner.id);
	await f.providers.remove(actor, f.planner.id);
	await expect(
		f.service.settings(actor, ticket, { plannerAgentId: implementer.id, implementerAgentId: implementer.id }),
	).rejects.toThrow("ticket-conflict");
	f.complete(plannerId, "Plan");
	await f.service.tick(actor);
	await f.service.message(actor, ticket, "Adjust plan");
	await f.service.tick(actor);
	expect(f.agents.dispatch.mock.calls.at(-1)?.[5]).toMatchObject({ model: "test-model", reasoningEffort: "high" });
	f.complete(plannerId, "Revised plan");
	await f.service.tick(actor);
	await f.service.approve(actor, ticket, 2);
	await f.makeService().tick(actor);
	const job = f.jobs.get(ticket.id)!;
	expect(job.implementationProviderSnapshot).toMatchObject({
		agentId: implementer.id,
		configuration: { kind: "ollama", model: "local" },
	});
	await f.taskAgents.save(
		actor,
		{ name: "Implementer", models: [{ providerId: f.implementer.id, model: "edited" }] },
		implementer.id,
	);
	f.complete(job.implementerId!);
	await f.service.tick(actor);
	f.merges.merge.mockResolvedValueOnce("rebase");
	await f.service.tick(actor);
	await f.service.tick(actor);
	expect(f.agents.dispatch.mock.calls.at(-1)?.[3]?.phase).toBe("rebase");
	expect(f.agents.dispatch.mock.calls.at(-1)?.[5]).toMatchObject({ model: "local" });
	expect(JSON.stringify(await f.service.get(actor, ticket.id))).not.toContain("http://");
});

test("skip planning needs only an implementer and retirement blocks unpinned dispatch", async () => {
	const f = namedFixture();
	const agent = await f.addAgent("Implementer", [{ providerId: f.implementer.id, model: "local" }]);
	const ticket = f.create();
	await f.service.settings(actor, ticket, { implementerAgentId: agent.id, skipPlanning: true });
	await f.service.move(actor, ticket, { status: "todo" });
	await f.taskAgents.retire(actor, agent.id);
	await f.service.tick(actor);
	expect(f.jobs.get(ticket.id)).toMatchObject({ state: "setup-failed", providerSelectionError: true });
	expect(f.agents.createTicketThread).not.toHaveBeenCalled();
	expect(ticket.status).toBe("todo");
	const replacement = await f.addAgent("Replacement");
	await f.service.settings(actor, ticket, { implementerAgentId: replacement.id, skipPlanning: true });
	await f.service.recover(actor, ticket.id);
	await f.service.tick(actor);
	expect(f.jobs.get(ticket.id)).toMatchObject({ state: "running", reservation: f.planner.id });
});

test("ordered fallbacks skip full and incompatible providers and the scheduler scans past a busy ticket", async () => {
	const f = namedFixture();
	const planner = await f.addAgent("OpenAI only");
	const local = { providerId: f.implementer.id, model: "first-local" };
	const fallback = await f.addAgent("With fallback", [...planner.models, local, { ...local, model: "second-local" }]);
	const holder = f.create();
	const waiting = f.create("TASK-2");
	const routed = f.create("TASK-3");
	await f.ready(holder, planner);
	await f.ready(waiting, planner);
	await f.ready(routed, fallback);
	await f.service.tick(actor);
	expect(waiting.status).toBe("todo");
	expect(f.jobs.get(waiting.id)).toMatchObject({ state: "queued" });
	expect(f.jobs.get(routed.id)).toMatchObject({
		reservation: f.implementer.id,
		planningProviderSnapshot: { model: "first-local" },
	});
	await f.taskAgents.save(actor, { name: fallback.name, models: [local, ...planner.models] }, fallback.id);
	const reviewing = f.create("TASK-4");
	await f.service.settings(actor, reviewing, {
		plannerAgentId: fallback.id,
		implementerAgentId: fallback.id,
		permissions: "approve-for-me",
	});
	await f.service.move(actor, reviewing, { status: "todo" });
	// Free local capacity. The incompatible option must still be skipped.
	f.complete(f.jobs.get(routed.id)!.plannerId!, "Plan");
	await f.service.tick(actor);
	await f.service.archive(actor, routed, "2026-11-14T00:00:00.000Z");
	await f.service.tick(actor);
	expect(reviewing.status).toBe("todo");
	expect(f.jobs.get(reviewing.id)).toMatchObject({ state: "queued" });
	await f.providers.remove(actor, f.planner.id);
	await f.service.tick(actor);
	expect(f.jobs.get(reviewing.id)).toMatchObject({ state: "setup-failed", providerSelectionError: true });
});

test("plan feedback rejects stale and approved revisions without queuing a turn", async () => {
	const f = fixture();
	const ticket = f.create();
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	const job = f.jobs.get(ticket.id)!;
	f.complete(job.plannerId!, "# Plan");
	await f.service.tick(actor);
	const current = f.tickets.get(ticket.id)!;
	await expect(f.service.message(actor, current, "Change scope", undefined, 2)).rejects.toThrow("ticket-conflict");
	expect(f.jobs.get(ticket.id)?.state).toBe("idle");
	await f.service.message(actor, current, "Change scope", undefined, 1);
	expect(f.jobs.get(ticket.id)?.state).toBe("queued");
	await expect(f.service.message(actor, current, "Duplicate", undefined, 1)).rejects.toThrow("ticket-conflict");
});

test("queued settings select direct implementation and recovery never dispatches twice", async () => {
	const f = fixture();
	const ticket = f.create();
	await f.service.move(actor, ticket, { status: "todo" });
	expect(f.jobs.get(ticket.id)?.phase).toBe("planning");
	await f.service.settings(actor, ticket, { skipPlanning: true, acceptRecommendations: true, permissions: "ask" });
	await f.service.tick(actor);
	const job = f.jobs.get(ticket.id)!;
	expect(job).toMatchObject({ phase: "implementation", state: "running" });
	expect(job.plannerId).toBeUndefined();
	expect(job.approvedRevision).toBeUndefined();
	expect(job.plan).toBeUndefined();
	expect(f.agents.dispatch.mock.calls[0]?.[2]).toContain("TASK-1 Add search");
	expect(f.agents.dispatch.mock.calls[0]?.[2]).toContain("Choose the recommended option");
	expect(f.agents.dispatch.mock.calls[0]?.[5]).toEqual({
		model: undefined,
		reasoningEffort: undefined,
		permissions: "ask",
	});
	await f.service.settings(actor, ticket, {});
	await f.service.recover(actor);
	await f.service.tick(actor);
	expect(f.agents.dispatch).toHaveBeenCalledTimes(1);
	expect(f.jobs.get(ticket.id)?.phase).toBe("implementation");
});

test("skip planning never approves an existing planner and restart uses the current settings", async () => {
	const f = fixture();
	const ticket = f.create();
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	await f.service.settings(actor, ticket, { skipPlanning: true });
	f.complete(f.jobs.get(ticket.id)!.plannerId!, "Saved plan");
	await f.service.tick(actor);
	expect(f.jobs.get(ticket.id)).toMatchObject({ phase: "planning", state: "idle" });
	expect(f.jobs.get(ticket.id)?.approvedRevision).toBeUndefined();
	await f.service.move(actor, ticket, { status: "backlog" });
	await f.service.recover(actor, ticket.id);
	await f.service.clearPlan(actor, ticket);
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	expect(f.jobs.get(ticket.id)).toMatchObject({ phase: "implementation", state: "running" });
	expect(f.jobs.get(ticket.id)?.plannerId).toBeUndefined();
	expect(f.agents.dispatch.mock.calls.at(-1)?.[2]).not.toContain("approved plan");
});

test("recommendations use current settings on the next feedback and rebase turns", async () => {
	const f = fixture();
	const ticket = f.create();
	await f.service.settings(actor, ticket, { skipPlanning: true });
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	await f.service.settings(actor, ticket, { skipPlanning: false, acceptRecommendations: true });
	const job = f.jobs.get(ticket.id)!;
	await f.service.message(actor, ticket, "Adjust scope", job.turnId);
	expect(f.agents.steer.mock.calls[0]?.[3]).toBe("Adjust scope");
	f.views.get(job.implementerId!)!.thread.status = "failed";
	f.pool.observe(job.implementerId!, "failed");
	await f.service.tick(actor);
	await f.service.message(actor, ticket, "Try again");
	await f.service.tick(actor);
	expect(f.agents.dispatch.mock.calls.at(-1)?.[2]).toContain("Try again\n\nChoose the recommended option");
	f.merges.merge.mockResolvedValue("rebase");
	f.complete(job.implementerId!);
	await f.service.tick(actor);
	await f.service.tick(actor);
	await f.service.tick(actor);
	expect(f.agents.dispatch.mock.calls.at(-1)?.[2]).toContain("Rebase this branch");
	expect(f.agents.dispatch.mock.calls.at(-1)?.[2]).toContain("Choose the recommended option");
	f.merges.merge.mockResolvedValue("merged");
	f.merges.candidate.mockResolvedValue("c".repeat(40));
	f.complete(job.implementerId!);
	await f.service.tick(actor);
	await f.service.tick(actor);
	expect(ticket.status).toBe("done");
});
const projectId = "123e4567-e89b-42d3-a456-426614174000";
const fixture = (
	dispatchMode: () => "running" | "paused" | "stopped" = () => "running",
	providers?: IModelProviderService,
	taskAgents?: ITaskAgents,
	quotaExhausted?: () => Promise<boolean>,
) => {
	const jobs = new Map<string, TicketWorkflowRecord>();
	const tickets = new Map<string, Ticket>();
	const views = new Map<string, AgentView>();
	const plans = new Map<string, string>();
	const pool = new AgentExecutionTracker();
	const agents = {
		stopTicket: vi.fn<ITicketAgents["stopTicket"]>(async () => true),
		assertRepositoryReady: vi.fn(async () => {}),
		catalogOptions: vi.fn<ITicketAgents["catalogOptions"]>(async () => ({
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
		countReservations: async (id: string) =>
			[...jobs.values()].filter((job) => job.reservation === id && !tickets.get(job.ticketId)?.archivedAt).length,
		countAgentReservations: async (id: string) =>
			[...jobs.values()].filter((job) => {
				const ticket = tickets.get(job.ticketId);
				if (!job.reservation || !ticket || ticket.archivedAt) return false;
				const implementing =
					job.state === "resetting" ? !!job.abandonment?.implementerId : job.phase !== "planning";
				return implementing
					? job.implementationProviderSnapshot?.agentId === id
					: job.planningProviderSnapshot?.agentId === id;
			}).length,
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
		list: vi.fn(async () => [...tickets.values()].map((ticket) => structuredClone(ticket))),
		insert: vi.fn(),
		update: vi.fn(async (id: string, input) => {
			Object.assign(tickets.get(id)!, input);
		}),
		archive: vi.fn(async (id: string, archivedAt: string) => {
			tickets.get(id)!.archivedAt ??= archivedAt;
		}),
		move: vi.fn(),
	};
	const merges = {
		isMerged: vi.fn(async () => false),
		candidate: vi.fn(async () => "b".repeat(40)),
		verify: vi.fn(async () => {}),
		merge: vi.fn(async (): Promise<"merged" | "rebase"> => "merged"),
		base: vi.fn(async () => "a".repeat(40)),
	};
	const wake = vi.fn();
	const cleanup = vi.fn(async (_actor: typeof actor, _workspaceId: string, _candidate: string) => {});
	const cleanupAbandoned = vi.fn(async (_actor: typeof actor, _workspaceId: string) => {});
	const makeService = () =>
		new TicketWorkflowService(
			store,
			ticketStore,
			agents,
			merges,
			{ cleanupMerged: cleanup },
			new TicketPrompts(),
			new AccessService({ owner: "owner", origin: "https://forge.example" }),
			wake,
			dispatchMode,
			{ cleanupAbandoned },
			providers,
			taskAgents,
			quotaExhausted,
		);
	const service = makeService();
	const create = (id = "TASK-1") => {
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
	return {
		service,
		makeService,
		jobs,
		tickets,
		views,
		pool,
		agents,
		merges,
		create,
		complete,
		wake,
		cleanup,
		cleanupAbandoned,
	};
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

test("unclaimed Ready returns while paused and revalidates edited scope", async () => {
	let paused = true;
	const f = fixture(() => (paused ? "paused" : "running"));
	const ticket = f.create();
	ticket.epicId = "EPIC-1";
	ticket.executionSettings = { permissions: "full-access" };
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	expect(f.agents.createTicketThread).not.toHaveBeenCalled();
	expect(await f.service.capabilities(actor, ticket)).toEqual({ canReturnToBacklog: true });
	await f.service.move(actor, ticket, { status: "backlog" });
	expect(f.jobs.get(ticket.id)).toMatchObject({ phase: "planning", state: "idle" });
	expect(ticket).toMatchObject({ epicId: "EPIC-1", executionSettings: { permissions: "full-access" } });
	const repositoryIds = ["123e4567-e89b-42d3-a456-426614174099", projectId];
	await f.service.update(actor, ticket.id, {
		title: "Updated scope",
		description: "New description",
		repositoryIds,
		epicId: null,
	});
	f.agents.assertRepositoryReady.mockRejectedValueOnce(new Error("Unavailable"));
	await expect(f.service.move(actor, ticket, { status: "todo" })).rejects.toThrow("ticket-conflict");
	await f.service.move(actor, ticket, { status: "todo" });
	paused = false;
	await f.service.tick(actor);
	expect(f.jobs.get(ticket.id)?.executionRepositoryId).toBe(repositoryIds[0]);
	expect(f.agents.createTicketThread).toHaveBeenCalledWith(
		actor,
		repositoryIds[0],
		`${ticket.id} planning`,
		undefined,
		expect.any(Function),
		undefined,
	);
	expect(f.agents.dispatch.mock.calls[0]?.[2]).toContain("Updated scope");
});

test("return winning serialization prevents a concurrent scheduler dispatch", async () => {
	const f = fixture();
	const ticket = f.create();
	await f.service.move(actor, ticket, { status: "todo" });
	let release!: () => void;
	let entered!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.agents.catalogOptions.mockImplementationOnce(async () => {
		entered();
		await held;
		return { models: [], skills: [] };
	});
	const blocker = f.service.settings(actor, ticket, {});
	await started;
	const returning = f.service.move(actor, { ...ticket }, { status: "backlog" });
	const ticking = f.service.tick(actor);
	release();
	await Promise.all([blocker, returning, ticking]);
	expect(ticket.status).toBe("backlog");
	expect(f.agents.createTicketThread).not.toHaveBeenCalled();
});

test.each(["success", "setup-failure", "capacity"] as const)(
	"pickup racing return rechecks eligibility after %s",
	async (outcome) => {
		const f = fixture();
		const ticket = f.create();
		await f.service.move(actor, ticket, { status: "todo" });
		const stale = { ...ticket };
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = f.agents.createTicketThread.getMockImplementation()!;
		f.agents.createTicketThread.mockImplementationOnce(async (...args) => {
			entered();
			await held;
			if (outcome === "setup-failure") throw new Error("Setup failed");
			if (outcome === "capacity") throw new AgentError("agent-capacity");
			return original(...args);
		});
		const ticking = f.service.tick(actor);
		await started;
		expect(await f.service.capabilities(actor, stale)).toEqual({ canReturnToBacklog: true });
		const returning = f.service.move(actor, stale, { status: "backlog" });
		release();
		await ticking;
		await returning;
		await f.service.recover(actor, ticket.id);
		expect(ticket.status).toBe("backlog");
	},
);

test("return eligibility covers recorded execution context and later workflow states", async () => {
	const f = fixture();
	const ticket = f.create();
	ticket.status = "todo";
	const base: TicketWorkflowRecord = { ticketId: ticket.id, phase: "planning", state: "queued", mergeAttempts: 0 };
	for (const context of [
		{ executionRepositoryId: projectId },
		{ workspaceId: projectId },
		{ plannerId: projectId },
		{ implementerId: projectId },
		{ turnId: "turn" },
		{ previousTurnId: "turn" },
		{ state: "setup-failed" },
		{ state: "failed" },
		{ state: "running" },
		{ state: "dispatching" },
		{ state: "uncertain" },
		{ state: "merge-queued" },
		{ phase: "implementation" },
	] as Partial<TicketWorkflowRecord>[]) {
		ticket.status = "todo";
		f.jobs.set(ticket.id, { ...base, ...context });
		expect(await f.service.capabilities(actor, ticket)).toEqual({ canReturnToBacklog: true });
		await f.service.move(actor, ticket, { status: "backlog" });
		await f.service.recover(actor, ticket.id);
		expect(f.jobs.get(ticket.id)).toMatchObject({ state: "idle", phase: "planning" });
	}
});

test.each(["planning", "implementation", "review", "rebase"] as const)(
	"abandon %s, wait for settlement, retry cleanup and ignore late results",
	async (phase) => {
		const f = fixture();
		const ticket = f.create();
		await f.service.move(actor, ticket, { status: "todo" });
		await f.service.tick(actor);
		const original = f.jobs.get(ticket.id)!;
		f.jobs.set(ticket.id, {
			...original,
			phase,
			plan: { revision: 2, text: "Saved plan" },
			approvedRevision: 2,
			message: "Feedback",
			resultSha: "b".repeat(40),
			mergeAttempts: 3,
		});
		f.agents.stopTicket.mockResolvedValue(false);
		await f.service.move(actor, ticket, { status: "backlog" });
		await f.service.recover(actor, ticket.id);
		expect(await f.service.get(actor, ticket.id)).toMatchObject({
			state: "resetting",
			resetStage: "stopping",
			plan: { text: "Saved plan" },
		});
		expect(await f.service.get(actor, ticket.id)).not.toHaveProperty("abandonment");
		expect(f.cleanupAbandoned).not.toHaveBeenCalled();
		await expect(f.service.clearPlan(actor, ticket)).rejects.toThrow("ticket-conflict");
		await expect(f.service.move(actor, ticket, { status: "todo" })).rejects.toThrow("ticket-conflict");
		await expect(f.service.message(actor, ticket, "late feedback")).rejects.toThrow("ticket-conflict");
		f.complete(original.plannerId!, "Late plan");
		f.agents.stopTicket.mockResolvedValue(true);
		f.cleanupAbandoned.mockRejectedValueOnce(new Error("Disk busy"));
		await f.service.recover(actor, ticket.id);
		expect(await f.service.get(actor, ticket.id)).toMatchObject({
			state: "resetting",
			resetStage: "cleanup",
			resetError: expect.any(String),
		});
		await f.service.recover(actor, ticket.id);
		expect(f.jobs.get(ticket.id)).toEqual({
			ticketId: ticket.id,
			plan: { revision: 2, text: "Saved plan" },
			mergeAttempts: 0,
			phase: "planning",
			approvedRevision: undefined,
			state: "idle",
		});
		expect(f.merges.merge).not.toHaveBeenCalled();
		await f.service.move(actor, ticket, { status: "todo" });
		await f.service.tick(actor);
		expect(f.jobs.get(ticket.id)).toMatchObject({ phase: "implementation", state: "running", approvedRevision: 2 });
		expect(f.agents.createTicketThread).toHaveBeenLastCalledWith(
			actor,
			projectId,
			`${ticket.id} implementation`,
			undefined,
			expect.any(Function),
			undefined,
		);
		expect(f.jobs.get(ticket.id)?.workspaceId).not.toBe(original.workspaceId);
		expect(f.agents.dispatch.mock.calls.at(-1)?.[2]).toContain("Saved plan");
	},
);

test("clear plan is idempotent and restarts planning with current scope", async () => {
	const f = fixture();
	const ticket = f.create();
	f.jobs.set(ticket.id, {
		ticketId: ticket.id,
		phase: "planning",
		state: "idle",
		mergeAttempts: 0,
		plan: { revision: 1, text: "Old plan" },
		approvedRevision: 1,
	});
	await expect(f.service.clearPlan({ username: "outsider" }, ticket)).rejects.toThrow("Access denied");
	await f.service.clearPlan(actor, ticket);
	await f.service.clearPlan(actor, ticket);
	await f.service.update(actor, ticket.id, {
		title: "New scope",
		description: "Current description",
		repositoryIds: [projectId],
	});
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	expect(f.jobs.get(ticket.id)?.phase).toBe("planning");
	expect(f.agents.dispatch.mock.calls.at(-1)?.[2]).toContain("New scope. Current description");
	await expect(f.service.clearPlan(actor, ticket)).rejects.toThrow("ticket-conflict");
});

test.each(["stopping", "cleanup"] as const)(
	"startup resumes abandonment in %s without replaying agents",
	async (stage) => {
		const f = fixture();
		const ticket = f.create();
		f.jobs.set(ticket.id, {
			ticketId: ticket.id,
			state: "resetting",
			phase: "planning",
			mergeAttempts: 0,
			plan: { revision: 1, text: "Retained" },
			resetStage: stage,
			abandonment: { workspaceId: "old-workspace", plannerId: "old-planner" },
		});
		const restarted = f.makeService();
		await restarted.recover(actor, ticket.id);
		expect(f.agents.stopTicket).toHaveBeenCalledTimes(stage === "stopping" ? 1 : 0);
		expect(f.cleanupAbandoned).toHaveBeenCalledWith(actor, "old-workspace");
		expect(f.jobs.get(ticket.id)).toMatchObject({ state: "idle", plan: { text: "Retained" } });
		expect(f.agents.dispatch).not.toHaveBeenCalled();
	},
);

test("delayed termination does not hold workflow serialization or dispatch unrelated tickets", async () => {
	const f = fixture();
	const ticket = f.create();
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	const stop = Promise.withResolvers<boolean>();
	f.agents.stopTicket.mockReturnValue(stop.promise);
	await f.service.move(actor, ticket, { status: "backlog" });
	const other = f.create("TASK-2");
	await f.service.move(actor, other, { status: "todo" });
	await f.service.tick(actor);
	expect(f.jobs.get(other.id)?.state).toBe("running");
	expect(f.jobs.get(ticket.id)?.state).toBe("resetting");
	await f.service.move(actor, ticket, { status: "backlog" });
	expect(f.agents.stopTicket).toHaveBeenCalledTimes(1);
	stop.resolve(true);
	await f.service.recover(actor, ticket.id);
	expect(f.jobs.get(ticket.id)?.state).toBe("idle");
});

test("return cancels a queued merge, but rejects a merge that already completed", async () => {
	const f = fixture();
	const ticket = f.create();
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.tick(actor);
	const job = f.jobs.get(ticket.id)!;
	f.jobs.set(ticket.id, { ...job, phase: "implementation", state: "merge-queued", resultSha: "b".repeat(40) });
	await f.service.move(actor, ticket, { status: "todo" });
	await f.service.recover(actor, ticket.id);
	expect(f.merges.merge).not.toHaveBeenCalled();
	ticket.status = "in-progress";
	f.jobs.set(ticket.id, { ...job, phase: "implementation", state: "merge-queued", resultSha: "b".repeat(40) });
	const stale = { ...ticket };
	await f.service.tick(actor);
	await expect(f.service.move(actor, stale, { status: "backlog" })).rejects.toThrow("ticket-conflict");
	expect(ticket.status).toBe("done");
});

test("scheduler ticks retry failed Backlog abandonment without blocking dispatch", async () => {
	const f = fixture();
	const ticket = f.create();
	f.jobs.set(ticket.id, {
		ticketId: ticket.id,
		state: "resetting",
		phase: "planning",
		mergeAttempts: 0,
		resetStage: "cleanup",
		abandonment: { workspaceId: "old-workspace" },
	});
	f.cleanupAbandoned.mockRejectedValueOnce(new Error("Busy"));
	await f.service.recover(actor, ticket.id);
	expect(f.jobs.get(ticket.id)?.resetError).toBeDefined();
	await f.service.tick(actor);
	await vi.waitFor(() => expect(f.jobs.get(ticket.id)?.state).toBe("idle"));
	expect(f.cleanupAbandoned).toHaveBeenCalledTimes(2);
});

test("return recovers an already applied Git merge before moving the ticket", async () => {
	const f = fixture();
	const ticket = f.create();
	ticket.status = "in-progress";
	f.jobs.set(ticket.id, {
		ticketId: ticket.id,
		phase: "implementation",
		state: "merge-queued",
		mergeAttempts: 0,
		workspaceId: "workspace",
		resultSha: "b".repeat(40),
	});
	f.merges.isMerged.mockResolvedValue(true);
	await expect(f.service.move(actor, ticket, { status: "backlog" })).rejects.toThrow("ticket-conflict");
	expect(ticket.status).toBe("done");
	expect(f.agents.stopTicket).not.toHaveBeenCalled();
	expect(f.cleanupAbandoned).not.toHaveBeenCalled();
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
	expect(f.agents.createTicketThread).toHaveBeenCalledWith(
		actor,
		first,
		`${ticket.id} planning`,
		undefined,
		expect.any(Function),
		undefined,
	);
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
		expect.any(Function),
		undefined,
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
	await f.service.options(actor, ticket.id);
	expect(f.agents.catalogOptions).toHaveBeenLastCalledWith(actor, f.jobs.get(ticket.id)?.plannerId);
	await f.service.settings(actor, ticket, {});
	expect(f.agents.dispatch.mock.calls[0]?.[5]).toEqual(settings);
	f.complete(f.jobs.get(ticket.id)!.plannerId!, "# Plan");
	await f.service.tick(actor);
	await f.service.approve(actor, f.tickets.get(ticket.id)!, 1);
	await f.service.options(actor, ticket.id);
	expect(f.agents.catalogOptions).toHaveBeenLastCalledWith(actor, undefined);
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
	const running = f.create("TASK-2");
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

test("planning starts in progress and approves only the displayed revision", async () => {
	const f = fixture();
	const ticket = f.create();
	await f.service.move(actor, ticket, { status: "todo" });
	expect(f.wake).toHaveBeenCalledOnce();
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

test("planning holds capacity through waits, feedback and restart, then approval releases it", async () => {
	const f = namedFixture();
	const planner = await f.addAgent("Planner");
	const implementer = await f.addAgent("Implementer", [{ providerId: f.implementer.id, model: "local" }]);
	const first = f.create();
	const second = f.create("TASK-2");
	await f.ready(first, planner, implementer);
	await f.ready(second, planner);
	await f.service.tick(actor);
	const thread = f.jobs.get(first.id)!.plannerId!;
	f.views.get(thread)!.thread.status = "waiting";
	const restarted = f.makeService();
	await restarted.recover(actor);
	await restarted.tick(actor);
	expect(second.status).toBe("todo");
	expect(f.jobs.get(first.id)?.reservation).toBe(f.planner.id);
	f.complete(thread, "# Plan");
	await f.service.tick(actor);
	expect(second.status).toBe("todo");
	await f.service.message(actor, first, "Revise the plan");
	await f.service.tick(actor);
	f.complete(thread, "# Revised");
	await f.service.tick(actor);
	await f.service.approve(actor, first, 2);
	expect(f.jobs.get(first.id)?.reservation).toBeUndefined();
	await f.service.tick(actor);
	expect(f.jobs.get(first.id)).toMatchObject({
		phase: "implementation",
		state: "running",
		reservation: f.implementer.id,
	});
	expect(f.jobs.get(second.id)).toMatchObject({ phase: "planning", state: "running", reservation: f.planner.id });
});

test.each(["setup-failed", "failed", "uncertain", "idle"] as const)(
	"persisted %s reservations retain capacity after service restart",
	async (state) => {
		const f = namedFixture();
		const agent = await f.addAgent("Planner");
		const first = f.create();
		first.status = "in-progress";
		f.jobs.set(first.id, {
			ticketId: first.id,
			state,
			phase: "planning",
			mergeAttempts: 0,
			reservation: f.planner.id,
		});
		const second = f.create("TASK-2");
		await f.ready(second, agent);
		const restarted = f.makeService();
		await restarted.recover(actor);
		await restarted.tick(actor);
		expect(second.status).toBe("todo");
		expect(f.agents.createTicketThread).not.toHaveBeenCalled();
	},
);

test("admission precedes setup, failures hold capacity, and limit changes preserve board order", async () => {
	const f = namedFixture();
	const agent = await f.addAgent("Planner", undefined, 3);
	const tickets = [f.create(), f.create("TASK-2"), f.create("TASK-3")];
	for (const ticket of tickets) await f.ready(ticket, agent);
	f.agents.createTicketThread.mockImplementationOnce(async () => {
		expect(tickets[0]!.status).toBe("in-progress");
		expect(f.jobs.get(tickets[0]!.id)).toMatchObject({
			reservation: f.planner.id,
			planningProviderSnapshot: { providerId: f.planner.id, model: "test-model" },
		});
		throw new Error("Setup unavailable");
	});
	await f.service.tick(actor);
	expect(tickets.map((ticket) => ticket.status)).toEqual(["in-progress", "todo", "todo"]);
	await f.providers.update(actor, f.planner.id, { maxConcurrentAgents: 2 });
	await f.service.tick(actor);
	expect(tickets.map((ticket) => ticket.status)).toEqual(["in-progress", "in-progress", "todo"]);
	await f.providers.update(actor, f.planner.id, { maxConcurrentAgents: 1 });
	await f.service.tick(actor);
	expect(f.jobs.get(tickets[1]!.id)?.state).toBe("running");
	await f.service.archive(actor, tickets[0]!, "2026-11-14T00:00:00.000Z");
	await f.service.tick(actor);
	expect(tickets[2]!.status).toBe("todo");
	f.agents.stopTicket.mockResolvedValue(false);
	await f.service.move(actor, tickets[1]!, { status: "backlog" });
	await f.service.tick(actor);
	expect(tickets[2]!.status).toBe("todo");
	expect(f.jobs.get(tickets[1]!.id)?.state).toBe("resetting");
	expect(f.cleanupAbandoned).not.toHaveBeenCalled();
	await expect(f.service.move(actor, tickets[1]!, { status: "todo" })).rejects.toThrow("ticket-conflict");
	f.agents.stopTicket.mockResolvedValue(true);
	await f.service.recover(actor, tickets[1]!.id);
	await f.service.tick(actor);
	expect(tickets[2]!.status).toBe("in-progress");
});

test("agent slots are shared across providers and phases and survive a scheduler restart", async () => {
	const f = namedFixture();
	const local = { providerId: f.implementer.id, model: "local" };
	const agent = await f.addAgent("Shared", [{ providerId: f.planner.id, model: "test-model" }, local]);
	const other = await f.addAgent("Other", [local]);
	const first = f.create();
	const second = f.create("TASK-2");
	const third = f.create("TASK-3");
	await f.ready(first, agent, agent, true);
	await f.ready(second, agent);
	await f.ready(third, other);
	await f.service.tick(actor);
	expect(f.jobs.get(first.id)).toMatchObject({ state: "running", reservation: f.planner.id });
	expect(f.jobs.get(second.id)).toMatchObject({ state: "queued" });
	expect(f.jobs.get(third.id)).toMatchObject({ state: "running", reservation: f.implementer.id });
	const restarted = f.makeService();
	await restarted.tick(actor);
	expect(second.status).toBe("todo");
	await f.taskAgents.save(actor, { name: agent.name, models: agent.models, maxConcurrentTickets: 2 }, agent.id);
	await f.providers.update(actor, f.implementer.id, { maxConcurrentAgents: 2 });
	await restarted.tick(actor);
	expect(f.jobs.get(second.id)).toMatchObject({ state: "running", reservation: f.implementer.id });
	await f.taskAgents.save(actor, { name: agent.name, models: agent.models, maxConcurrentTickets: 1 }, agent.id);
	expect(f.jobs.get(first.id)?.state).toBe("running");
	expect(f.jobs.get(second.id)?.state).toBe("running");
});

test("exhausted OpenAI quota routes new work to the next provider and queues cloud-only work", async () => {
	const quota = vi.fn(async () => true);
	const f = namedFixture(undefined, quota);
	const cloud = await f.addAgent("Cloud");
	const fallback = await f.addAgent("Fallback", [...cloud.models, { providerId: f.implementer.id, model: "local" }]);
	const waiting = f.create();
	const routed = f.create("TASK-2");
	await f.ready(waiting, cloud);
	await f.ready(routed, fallback);
	await f.service.tick(actor);
	expect(quota).toHaveBeenCalledTimes(1);
	expect(f.jobs.get(waiting.id)).toMatchObject({ state: "queued" });
	expect(f.jobs.get(routed.id)).toMatchObject({ state: "running", reservation: f.implementer.id });
	quota.mockResolvedValue(false);
	await f.service.tick(actor);
	expect(f.jobs.get(waiting.id)).toMatchObject({ state: "running", reservation: f.planner.id });
});

test.each(["todo", "backlog"] as const)("return to %s holds capacity until cancellation settles", async (status) => {
	const f = namedFixture();
	const agent = await f.addAgent("Implementer");
	const first = f.create();
	await f.ready(first, agent, agent, true);
	await f.service.tick(actor);
	const next = f.create("TASK-2");
	await f.ready(next, agent);
	f.agents.stopTicket.mockResolvedValue(false);
	await f.service.move(actor, first, { status });
	await f.service.tick(actor);
	expect(next.status).toBe("todo");
	expect(f.jobs.get(first.id)).toMatchObject({ state: "resetting", reservation: f.planner.id });
	expect(f.cleanupAbandoned).not.toHaveBeenCalled();
});

test("failure, stop and rebases retain implementation capacity until Done", async () => {
	let mode: "running" | "stopped" = "running";
	const f = namedFixture(() => mode);
	const agent = await f.addAgent("Implementer");
	const ticket = f.create();
	await f.ready(ticket, agent, agent, true);
	await f.service.tick(actor);
	const id = f.jobs.get(ticket.id)!.implementerId!;
	const next = f.create("TASK-2");
	await f.ready(next, await f.addAgent("Competitor"));
	for (const slot of ["one", "two", "three"]) f.pool.claim(slot);
	f.views.get(id)!.thread.status = "failed";
	mode = "stopped";
	await f.service.tick(actor);
	await f.taskAgents.save(
		actor,
		{ name: agent.name, models: [{ providerId: f.implementer.id, model: "other-model" }] },
		agent.id,
	);
	await f.service.message(actor, ticket, "Retry");
	await f.service.tick(actor);
	expect(f.jobs.get(ticket.id)).toMatchObject({ state: "queued", reservation: f.planner.id });
	mode = "running";
	await f.service.tick(actor);
	expect(next.status).toBe("todo");
	expect(f.agents.dispatch.mock.lastCall?.[5]?.model).toBe("test-model");
	f.complete(id);
	await f.service.tick(actor);
	f.merges.merge.mockResolvedValueOnce("rebase");
	await f.service.tick(actor);
	await f.service.tick(actor);
	expect(next.status).toBe("todo");
	expect(f.jobs.get(ticket.id)).toMatchObject({ phase: "rebase", state: "running", reservation: f.planner.id });
	expect(f.agents.dispatch.mock.lastCall?.[5]?.model).toBe("test-model");
	f.merges.candidate.mockResolvedValueOnce("c".repeat(40));
	f.complete(id);
	await f.service.tick(actor);
	await f.service.tick(actor);
	expect(ticket.status).toBe("done");
	expect(f.jobs.get(ticket.id)?.reservation).toBeUndefined();
	expect(next.status).toBe("in-progress");
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
	await f.service.recover(actor, ticket.id);
	expect(f.cleanup).toHaveBeenCalledTimes(2);
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
