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
		attention: vi.fn(async () => []),
		get: async (id: string) => structuredClone(jobs.get(id)),
		list: async () => [...jobs.values()].map((job) => structuredClone(job)),
		save: vi.fn(async (job: TicketWorkflowRecord, move?: { status: Ticket["status"] }) => {
			jobs.set(job.ticketId, structuredClone(job));
			if (move) tickets.get(job.ticketId)!.status = move.status;
		}),
	};
	const ticketStore = {
		get: async (id: string) => structuredClone(tickets.get(id)),
		list: vi.fn(),
		insert: vi.fn(),
		update: vi.fn(),
		move: vi.fn(),
	};
	const merges = {
		candidate: vi.fn(async () => "b".repeat(40)),
		verify: vi.fn(async () => {}),
		merge: vi.fn(async (): Promise<"merged" | "rebase"> => "merged"),
		base: vi.fn(async () => "a".repeat(40)),
	};
	const wake = vi.fn();
	const service = new TicketWorkflowService(
		store,
		ticketStore,
		agents,
		pool,
		merges,
		new TicketPrompts(),
		new AccessService({ owner: "owner", origin: "https://forge.example" }),
		wake,
	);
	const create = (id = "FORGE-1") => {
		const ticket: Ticket = {
			id,
			projectId,
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
	return { service, jobs, tickets, views, pool, agents, merges, create, complete, wake };
};

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
