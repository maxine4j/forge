import { createLogger } from "@forge/backend-infrastructure/logger";
import type { Ticket, MoveTicket, TicketWorkflow } from "@forge/contracts/tickets";
import { z } from "zod";

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

export interface ITicketWorkflowService {
	move(actor: Actor, ticket: Ticket, input: MoveTicket): Promise<void>;
	get(actor: Actor, id: string): Promise<TicketWorkflow>;
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
	) {}
	async move(actor: Actor, ticket: Ticket, input: MoveTicket): Promise<void> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const current = await this.tickets.get(ticket.id);
			if (!current || current.status !== ticket.status) throw new TicketError("ticket-conflict");
			const job = await this.get(actor, ticket.id);
			if (input.status === ticket.status) {
				await this.store.save(job, input);
				return;
			}
			if (ticket.status === "backlog" && input.status === "todo") {
				await this.store.save({ ...job, phase: "planning", state: "queued", plan: undefined }, input);
				return;
			}
			if (job.state !== "idle") throw new TicketError("ticket-conflict");
			if (ticket.status === "todo" && input.status === "in-progress" && job.plan) {
				await this.store.save(
					{
						...job,
						phase: "implementation",
						state: "queued",
						approvedRevision: job.plan.revision,
						message: undefined,
					},
					input,
				);
				return;
			}
			if (ticket.status === "in-review" && input.status === "merging" && job.implementerId) {
				await this.store.save(
					{ ...job, state: "queued", phase: "rebase", mergeAttempts: 0, message: undefined },
					input,
				);
				return;
			}
			throw new TicketError("ticket-conflict");
		});
	}
	async get(actor: Actor, id: string): Promise<TicketWorkflow> {
		this.access.assertOwner(actor);
		if (!(await this.tickets.get(id))) throw new TicketError("ticket-not-found");
		return (
			(await this.store.get(id)) ?? { ticketId: id, phase: "planning", state: "idle", mergeAttempts: 0, run: 0 }
		);
	}
	async message(actor: Actor, ticket: Ticket, text: string): Promise<TicketWorkflow> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const current = await this.tickets.get(ticket.id);
			const job = await this.get(actor, ticket.id);
			if (
				!current
				|| !["todo", "in-review", "in-progress", "merging"].includes(current.status)
				|| !["idle", "failed"].includes(job.state)
				|| !text.trim()
				|| text.length > 8000
			)
				throw new TicketError("ticket-conflict");
			const next: TicketWorkflow = {
				...job,
				state: "queued",
				message: text.trim(),
				phase: current.status === "todo" ? "planning" : current.status === "merging" ? "rebase" : "review",
				mergeAttempts: current.status === "merging" ? 0 : job.mergeAttempts,
			};
			await this.store.save(next);
			return next;
		});
	}
	async tick(actor: Actor): Promise<void> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			for (const job of await this.store.list()) {
				const ticket = await this.tickets.get(job.ticketId);
				if (!ticket || ["backlog", "done"].includes(ticket.status)) continue;
				try {
					if (job.state === "running") await this.observe(actor, ticket, job);
					else if (job.state === "queued") {
						if (ticket.status === "merging" && !job.message) await this.merge(actor, job);
						else if (this.pool.available()) await this.dispatch(actor, ticket, job);
					}
				} catch (err) {
					this.log.error({ err, ticketId: ticket.id }, "Ticket execution needs attention");
					if (err instanceof AgentError && err.code === "agent-capacity") {
						await this.store.save({ ...job, state: "queued" });
					} else
						await this.store.save({ ...job, state: job.state === "dispatching" ? "uncertain" : "failed" });
				}
			}
		});
	}
	async recover(actor: Actor, ticketId?: string): Promise<void> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const selected = ticketId ? [await this.get(actor, ticketId)] : await this.store.list();
			for (const job of selected) {
				if (!["running", "dispatching", "uncertain"].includes(job.state)) continue;
				const ticket = await this.tickets.get(job.ticketId);
				if (!ticket) continue;
				const id = job.phase === "planning" ? job.plannerId : job.implementerId;
				await this.store.save({ ...job, state: "uncertain" });
				if (!id) continue;
				try {
					const view = await this.agents.resume(actor, id);
					if (view.thread.status === "idle" || view.thread.status === "uncertain") continue;
					await this.observe(actor, ticket, job);
				} catch (err) {
					this.log.error({ err, ticketId: ticket.id }, "Could not reconcile ticket execution");
				}
			}
		});
	}
	private async dispatch(actor: Actor, ticket: Ticket, job: TicketWorkflow): Promise<void> {
		job.state = "dispatching";
		job.run = (job.run ?? 0) + 1;
		await this.store.save(job);
		if (!job.plannerId) {
			const view = await this.agents.createTicketThread(actor, ticket.projectId, `${ticket.id} planning`);
			job.plannerId = view.thread.id;
			job.workspaceId = view.thread.workspaceId;
			job.baseSha = await this.merges.base(actor, job.workspaceId);
			await this.store.save(job);
		}
		if (job.phase !== "planning" && !job.implementerId) {
			const view = await this.agents.createTicketThread(
				actor,
				ticket.projectId,
				`${ticket.id} implementation`,
				job.workspaceId,
			);
			job.implementerId = view.thread.id;
			await this.store.save(job);
		}
		const id = job.phase === "planning" ? job.plannerId : job.implementerId!;
		await this.agents.dispatch(actor, id, this.prompts.build(ticket, job), {
			ticketId: ticket.id,
			phase: job.phase,
		});
		job.state = "running";
		await this.store.save(job);
	}
	private async observe(actor: Actor, ticket: Ticket, job: TicketWorkflow): Promise<void> {
		const id = job.phase === "planning" ? job.plannerId : job.implementerId;
		if (!id) return;
		const view = await this.agents.get(actor, id);
		if (["running", "waiting", "creating"].includes(view.thread.status)) {
			await this.store.save({ ...job, state: "running" });
			return;
		}
		if (view.thread.status !== "completed") {
			await this.store.save({ ...job, state: view.thread.status === "uncertain" ? "uncertain" : "failed" });
			return;
		}
		const answer = view.items.findLast((item) => item.role === "assistant")?.text.trim();
		let artifact;
		try {
			artifact = z
				.discriminatedUnion("kind", [
					z.strictObject({ kind: z.literal("plan"), run: z.number(), text: z.string().min(1).max(28000) }),
					z.strictObject({
						kind: z.literal("complete"),
						run: z.number(),
						commit: z.string().regex(/^[a-f0-9]{40}$/u),
						validation: z.string().min(1),
					}),
				])
				.parse(JSON.parse(answer?.split("FORGE_RESULT\n").at(-1) ?? ""));
		} catch {
			await this.store.save({ ...job, state: "failed" });
			return;
		}
		if (artifact.run !== job.run || (job.phase === "planning") !== (artifact.kind === "plan")) {
			await this.store.save({ ...job, state: "failed" });
			return;
		}
		job.state = "idle";
		job.message = undefined;
		if (job.phase === "planning") {
			if (artifact.kind !== "plan") return;
			job.plan = { revision: (job.plan?.revision ?? 0) + 1, text: artifact.text };
			await this.store.save(job);
		} else {
			if (artifact.kind !== "complete" || !job.workspaceId) throw new TicketError("ticket-conflict");
			await this.merges.verify(actor, job.workspaceId, artifact.commit);
			job.resultSha = artifact.commit;
			// Persist the validated candidate before the nontransactional Git update.
			if (ticket.status === "merging") job.state = "queued";
			await this.store.save(job, ticket.status === "in-progress" ? { status: "in-review" } : undefined);
			if (ticket.status === "merging") {
				await this.merge(actor, job);
			}
		}
	}
	private async merge(actor: Actor, job: TicketWorkflow): Promise<void> {
		if (!job.workspaceId || !job.resultSha) throw new TicketError("ticket-conflict");
		if ((await this.merges.merge(actor, job.workspaceId, job.resultSha)) === "merged") {
			await this.store.save({ ...job, state: "idle", message: undefined }, { status: "done" });
		} else {
			const exhausted = job.mergeAttempts >= 3;
			job.mergeAttempts = Math.min(3, job.mergeAttempts + 1);
			await this.store.save({
				...job,
				phase: "rebase",
				state: exhausted ? "failed" : "queued",
				message: "Rebase onto latest main and validate.",
			});
		}
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.catch(() => {});
		return result;
	}
}
