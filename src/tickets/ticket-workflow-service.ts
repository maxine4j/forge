import { createLogger } from "@forge/backend-infrastructure/logger";
import type { Ticket, MoveTicket, TicketWorkflow } from "@forge/contracts/tickets";

import type { IAgentExecutionPool } from "../agents/agent-execution-pool.ts";
import type { ITicketAgents } from "../agents/agent-service.ts";
import { AgentError } from "../agents/errors.ts";
import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { ITicketMergeClient } from "../workspaces/workspace-merge-client.ts";
import { TicketError } from "./errors.ts";
import type { ITicketPrompts } from "./ticket-prompts.ts";
import type { ITicketStore } from "./ticket-store.ts";
import type { ITicketWorkflowStore } from "./ticket-workflow-store.ts";
import type { TicketWorkflowRecord } from "./types.ts";

export interface ITicketWorkflowService {
	/** Archives between scheduler operations. Active or unresolved execution and pending merges conflict. */
	archive(actor: Actor, ticket: Ticket, archivedAt: string): Promise<void>;
	move(actor: Actor, ticket: Ticket, input: MoveTicket): Promise<void>;
	get(actor: Actor, id: string): Promise<TicketWorkflow>;
	attention(actor: Actor, projectId: string): Promise<string[]>;
	approve(actor: Actor, ticket: Ticket, revision: number): Promise<TicketWorkflow>;
	queueMerge(actor: Actor, ticket: Ticket): Promise<TicketWorkflow>;
	message(actor: Actor, ticket: Ticket, text: string): Promise<TicketWorkflow>;
	tick(actor: Actor): Promise<void>;
	recover(actor: Actor, id?: string): Promise<void>;
}

export class TicketWorkflowService implements ITicketWorkflowService {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly log = createLogger(TicketWorkflowService.name);
	constructor(
		private readonly store: ITicketWorkflowStore,
		private readonly tickets: ITicketStore,
		private readonly agents: ITicketAgents,
		private readonly pool: IAgentExecutionPool,
		private readonly merges: ITicketMergeClient,
		private readonly prompts: ITicketPrompts,
		private readonly access: IAccessService,
		private readonly wake: () => void = () => {},
	) {}
	async archive(actor: Actor, ticket: Ticket, archivedAt: string): Promise<void> {
		this.access.assertOwner(actor);
		await this.serialize(async () => {
			const job = await this.record(ticket.id);
			if (["running", "dispatching", "uncertain", "merge-queued"].includes(job.state))
				throw new TicketError("ticket-conflict");
			await this.tickets.archive(ticket.id, archivedAt);
		});
	}
	async move(actor: Actor, ticket: Ticket, input: MoveTicket): Promise<void> {
		this.access.assertOwner(actor);
		await this.serialize(async () => {
			const current = await this.tickets.get(ticket.id);
			if (!current || current.archivedAt || current.status !== ticket.status)
				throw new TicketError("ticket-conflict");
			if (input.beforeId) {
				const before = await this.tickets.get(input.beforeId);
				if (before?.archivedAt || before?.status !== input.status) throw new TicketError("ticket-conflict");
			}
			const job = await this.record(ticket.id);
			if (input.status === ticket.status) {
				await this.store.save(job, input);
			} else if (ticket.status === "backlog" && input.status === "todo") {
				await this.store.save({ ...job, phase: "planning", state: "queued" }, input);
			} else {
				throw new TicketError("ticket-conflict");
			}
		});
		if (input.status === "todo") this.wake();
	}
	async get(actor: Actor, id: string): Promise<TicketWorkflow> {
		this.access.assertOwner(actor);
		if (!(await this.tickets.get(id))) throw new TicketError("ticket-not-found");
		return this.summary(await this.record(id));
	}
	async attention(actor: Actor, projectId: string): Promise<string[]> {
		this.access.assertOwner(actor);
		return this.store.attention(projectId);
	}
	async approve(actor: Actor, ticket: Ticket, revision: number): Promise<TicketWorkflow> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const job = await this.inProgress(ticket.id);
			if (job.phase !== "planning" || job.state !== "idle" || job.plan?.revision !== revision)
				throw new TicketError("ticket-conflict");
			const next: TicketWorkflowRecord = {
				...job,
				phase: "implementation",
				state: "queued",
				approvedRevision: revision,
			};
			await this.store.save(next);
			this.wake();
			return this.summary(next);
		});
	}
	async queueMerge(actor: Actor, ticket: Ticket): Promise<TicketWorkflow> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const job = await this.inProgress(ticket.id);
			if (!job.resultSha || !((job.phase === "review" && job.state === "idle") || job.state === "failed"))
				throw new TicketError("ticket-conflict");
			const next: TicketWorkflowRecord = { ...job, state: "merge-queued", mergeAttempts: 0, message: undefined };
			await this.store.save(next);
			this.wake();
			return this.summary(next);
		});
	}
	async message(actor: Actor, ticket: Ticket, text: string): Promise<TicketWorkflow> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const job = await this.inProgress(ticket.id);
			const threadId = job.phase === "planning" ? job.plannerId : job.implementerId;
			if (!threadId || !["idle", "failed"].includes(job.state) || !text.trim() || text.length > 8000)
				throw new TicketError("ticket-conflict");
			const next: TicketWorkflowRecord = {
				...job,
				state: "queued",
				message: text.trim(),
				mergeAttempts: job.phase === "rebase" ? 0 : job.mergeAttempts,
			};
			await this.store.save(next);
			this.wake();
			return this.summary(next);
		});
	}
	async tick(actor: Actor): Promise<void> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			for (const job of await this.store.list()) {
				const ticket = await this.tickets.get(job.ticketId);
				if (!ticket || ticket.archivedAt || ticket.status === "backlog" || ticket.status === "done") continue;
				try {
					if (job.state === "running") await this.observe(actor, job);
					else if (job.state === "merge-queued") await this.merge(actor, job);
					else if (job.state === "queued" && this.pool.available()) await this.dispatch(actor, ticket, job);
				} catch (err) {
					this.log.error({ err, ticketId: ticket.id }, "Ticket execution needs attention");
					if (err instanceof AgentError && err.code === "agent-capacity") {
						if (job.state === "dispatching") await this.store.save({ ...job, state: "queued" });
						continue;
					}
					const state =
						job.state === "queued" ? "setup-failed" : job.state === "dispatching" ? "uncertain" : "failed";
					await this.store.save(
						{ ...job, state },
						ticket.status === "todo" ? { status: "in-progress" } : undefined,
					);
				}
			}
		});
	}
	async recover(actor: Actor, ticketId?: string): Promise<void> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			if (ticketId) {
				const ticket = await this.tickets.get(ticketId);
				if (!ticket) throw new TicketError("ticket-not-found");
				if (ticket.archivedAt) throw new TicketError("ticket-conflict");
			}
			const selected = ticketId ? [await this.record(ticketId)] : await this.store.list();
			for (const job of selected) {
				if (ticketId && job.state === "setup-failed") {
					await this.store.save({ ...job, state: "queued" });
					this.wake();
					continue;
				}
				if (!["running", "dispatching", "uncertain"].includes(job.state)) continue;
				const id = job.phase === "planning" ? job.plannerId : job.implementerId;
				await this.store.save({ ...job, state: "uncertain" });
				if (!id) continue;
				try {
					await this.agents.resume(actor, id);
					await this.observe(actor, { ...job, state: "uncertain" });
				} catch (err) {
					this.log.error({ err, ticketId: job.ticketId }, "Could not reconcile ticket execution");
					if (err instanceof TicketError && err.code === "ticket-conflict")
						await this.store.save({ ...job, state: "failed" });
				}
			}
		});
	}
	private async record(id: string): Promise<TicketWorkflowRecord> {
		return (await this.store.get(id)) ?? { ticketId: id, phase: "planning", state: "idle", mergeAttempts: 0 };
	}
	private async inProgress(id: string): Promise<TicketWorkflowRecord> {
		const ticket = await this.tickets.get(id);
		if (ticket?.archivedAt || ticket?.status !== "in-progress") throw new TicketError("ticket-conflict");
		return this.record(id);
	}
	private summary({ previousTurnId: _previous, turnId: _turn, ...workflow }: TicketWorkflowRecord): TicketWorkflow {
		return workflow;
	}
	private async dispatch(actor: Actor, ticket: Ticket, job: TicketWorkflowRecord): Promise<void> {
		const planning = job.phase === "planning";
		let id = planning ? job.plannerId : job.implementerId;
		let releaseReservation = false;
		try {
			if (!id) {
				if (!planning && !job.workspaceId) throw new TicketError("ticket-conflict");
				const view = await this.agents.createTicketThread(
					actor,
					ticket.projectId,
					`${ticket.id} ${planning ? "planning" : "implementation"}`,
					planning ? undefined : job.workspaceId,
					true,
				);
				id = view.thread.id;
				releaseReservation = true;
				if (planning) {
					job.plannerId = id;
					job.workspaceId = view.thread.workspaceId;
				} else {
					job.implementerId = id;
				}
			}
			if (planning && !job.baseSha && job.workspaceId)
				job.baseSha = await this.merges.base(actor, job.workspaceId);
			job.previousTurnId = (await this.agents.get(actor, id)).thread.turnId;
			job.turnId = undefined;
			job.state = "dispatching";
			await this.store.save(job, ticket.status === "todo" ? { status: "in-progress" } : undefined);
			releaseReservation = false;
			const view = await this.agents.dispatch(actor, id, this.prompts.build(ticket, job), {
				ticketId: ticket.id,
				phase: job.phase,
			});
			job.state = "running";
			job.turnId = view.thread.turnId;
			await this.store.save(job);
		} catch (err) {
			if (releaseReservation) this.pool.observe(id!, "idle");
			throw err;
		}
	}
	private async observe(actor: Actor, job: TicketWorkflowRecord): Promise<void> {
		const id = job.phase === "planning" ? job.plannerId : job.implementerId;
		if (!id) return;
		const { thread } = await this.agents.get(actor, id);
		if (thread.status === "uncertain") {
			await this.store.save({ ...job, state: "uncertain" });
			return;
		}
		if (!thread.turnId || thread.turnId === job.previousTurnId || (job.turnId && thread.turnId !== job.turnId)) {
			if (thread.status !== "running" && thread.status !== "waiting")
				await this.store.save({ ...job, state: "uncertain" });
			return;
		}
		if (thread.status === "running" || thread.status === "waiting") {
			if (job.state !== "running" || !job.turnId)
				await this.store.save({ ...job, state: "running", turnId: thread.turnId });
			return;
		}
		if (thread.status !== "completed") {
			await this.store.save({ ...job, state: "failed" });
			return;
		}
		if (job.phase === "planning") {
			const text = await this.agents.plan(actor, id, thread.turnId);
			if (!text) {
				await this.store.save({ ...job, state: "failed" });
				return;
			}
			const plan = { revision: (job.plan?.revision ?? 0) + 1, text };
			await this.store.save({ ...job, plan, state: "idle", message: undefined });
		} else {
			if (!job.workspaceId) throw new TicketError("ticket-conflict");
			const resultSha = await this.merges.candidate(actor, job.workspaceId);
			if (resultSha === job.baseSha || resultSha === job.resultSha) throw new TicketError("ticket-conflict");
			// Persist the verified candidate before the nontransactional Git update.
			await this.store.save({
				...job,
				resultSha,
				state: job.phase === "review" ? "idle" : "merge-queued",
				message: undefined,
			});
			this.wake();
		}
	}
	private async merge(actor: Actor, job: TicketWorkflowRecord): Promise<void> {
		if (!job.workspaceId || !job.resultSha) throw new TicketError("ticket-conflict");
		if ((await this.merges.merge(actor, job.workspaceId, job.resultSha)) === "merged") {
			await this.store.save({ ...job, state: "idle", message: undefined }, { status: "done" });
			this.wake();
		} else {
			const exhausted = job.mergeAttempts >= 3;
			await this.store.save({
				...job,
				phase: "rebase",
				state: exhausted ? "failed" : "queued",
				mergeAttempts: Math.min(3, job.mergeAttempts + 1),
				message: undefined,
			});
			if (!exhausted) this.wake();
		}
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.catch(() => {});
		return result;
	}
}
