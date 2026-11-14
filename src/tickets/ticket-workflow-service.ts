import { createLogger } from "@forge/backend-infrastructure/logger";
import { resolveAgentSettings, type AgentOptions } from "@forge/contracts/agents";
import { ticketExecutionSettingsSchema, type TicketExecutionSettings } from "@forge/contracts/tickets";
import type { BoardSettings, Ticket, CreateTicket, MoveTicket, TicketWorkflow } from "@forge/contracts/tickets";

import type { ITicketAgents } from "../agents/agent-service.ts";
import { AgentCatalogError, AgentError } from "../agents/errors.ts";
import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { ITicketMergeClient } from "../workspaces/workspace-merge-client.ts";
import type { IMergedWorkspaceCleanup, IAbandonedWorkspaceCleanup } from "../workspaces/workspace-service.ts";
import { TicketError } from "./errors.ts";
import type { ITicketPrompts } from "./ticket-prompts.ts";
import type { ITicketStore } from "./ticket-store.ts";
import type { ITicketWorkflowStore } from "./ticket-workflow-store.ts";
import type { TicketWorkflowRecord } from "./types.ts";

export interface ITicketWorkflowService {
	update(actor: Actor, id: string, input: CreateTicket): Promise<void>;
	options(actor: Actor, ticketId?: string): Promise<AgentOptions>;
	validateSettings(actor: Actor, settings: TicketExecutionSettings): Promise<void>;
	settings(actor: Actor, ticket: Ticket, settings: TicketExecutionSettings): Promise<void>;
	/** Archives between scheduler operations. Active or unresolved execution and pending merges conflict. */
	archive(actor: Actor, ticket: Ticket, archivedAt: string): Promise<void>;
	move(actor: Actor, ticket: Ticket, input: MoveTicket): Promise<void>;
	clearPlan(actor: Actor, ticket: Ticket): Promise<TicketWorkflow>;
	capabilities(actor: Actor, ticket: Ticket): Promise<Pick<Ticket, "canReturnToBacklog" | "resetting">>;
	get(actor: Actor, id: string): Promise<TicketWorkflow>;
	boardSummary(actor: Actor): Promise<Map<string, Pick<Ticket, "agentStatus" | "needsAttention">>>;
	approve(actor: Actor, ticket: Ticket, revision: number): Promise<TicketWorkflow>;
	queueMerge(actor: Actor, ticket: Ticket): Promise<TicketWorkflow>;
	message(actor: Actor, ticket: Ticket, text: string, expectedTurnId?: string): Promise<TicketWorkflow>;
	tick(actor: Actor): Promise<void>;
	recover(actor: Actor, id?: string): Promise<void>;
}

export class TicketWorkflowService implements ITicketWorkflowService {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly settingUp = new Set<string>();
	private readonly resetting = new Map<string, Promise<void>>();
	private readonly log = createLogger(TicketWorkflowService.name);
	async options(actor: Actor, ticketId?: string): Promise<AgentOptions> {
		this.access.assertOwner(actor);
		try {
			const job = ticketId ? await this.store.get(ticketId) : undefined;
			const threadId = job?.phase === "planning" ? job.plannerId : job?.implementerId;
			return await this.agents.catalogOptions(actor, threadId);
		} catch (cause) {
			throw new TicketError("ticket-unavailable", { cause });
		}
	}
	async validateSettings(actor: Actor, settings: TicketExecutionSettings): Promise<void> {
		this.access.assertOwner(actor);
		const parsed = ticketExecutionSettingsSchema.safeParse(settings);
		if (!parsed.success) throw new TicketError("invalid-request");
		const options = await this.options(actor);
		if (!resolveAgentSettings(options, parsed.data).supported) throw new TicketError("unsupported-settings");
	}
	async settings(actor: Actor, ticket: Ticket, settings: TicketExecutionSettings): Promise<void> {
		this.access.assertOwner(actor);
		const parsed = ticketExecutionSettingsSchema.safeParse(settings);
		if (!parsed.success) throw new TicketError("invalid-request");
		await this.serialize(async () => {
			const current = await this.tickets.get(ticket.id);
			if (!current || current.archivedAt || current.status === "done") throw new TicketError("ticket-conflict");
			if ((await this.record(ticket.id)).state === "resetting") throw new TicketError("ticket-conflict");
			const options = await this.options(actor, ticket.id);
			const previous = current.executionSettings;
			const { model, reasoningEffort, permissions } = parsed.data;
			const modelChanged = model !== previous?.model;
			const effortChanged = reasoningEffort !== previous?.reasoningEffort;
			const validateModel = modelChanged || (effortChanged && reasoningEffort !== undefined);
			if (
				!resolveAgentSettings(options, {
					model: validateModel ? model : undefined,
					reasoningEffort: validateModel ? reasoningEffort : undefined,
					permissions: permissions === previous?.permissions ? undefined : permissions,
				}).supported
			)
				throw new TicketError("unsupported-settings");
			await this.tickets.updateSettings(ticket.id, parsed.data);
		});
	}
	constructor(
		private readonly store: ITicketWorkflowStore,
		private readonly tickets: ITicketStore,
		private readonly agents: ITicketAgents,
		private readonly maxConcurrentTickets: () => number,
		private readonly merges: ITicketMergeClient,
		private readonly workspaceCleanup: IMergedWorkspaceCleanup,
		private readonly prompts: ITicketPrompts,
		private readonly access: IAccessService,
		private readonly wake: () => void = () => {},
		private readonly dispatchMode: () => BoardSettings["dispatch"] = () => "running",
		private readonly abandonmentCleanup?: IAbandonedWorkspaceCleanup,
	) {}
	async update(actor: Actor, id: string, input: CreateTicket): Promise<void> {
		this.access.assertOwner(actor);
		await this.serialize(async () => {
			const ticket = await this.tickets.get(id);
			if (!ticket || ticket.archivedAt || ticket.status !== "backlog") throw new TicketError("ticket-conflict");
			if ((await this.record(id)).state === "resetting") throw new TicketError("ticket-conflict");
			await this.tickets.update(id, input);
		});
	}
	async archive(actor: Actor, ticket: Ticket, archivedAt: string): Promise<void> {
		this.access.assertOwner(actor);
		await this.serialize(async () => {
			const job = await this.record(ticket.id);
			if (["running", "dispatching", "uncertain", "merge-queued", "resetting"].includes(job.state))
				throw new TicketError("ticket-conflict");
			await this.tickets.archive(ticket.id, archivedAt);
		});
		this.wake();
	}
	async move(actor: Actor, ticket: Ticket, input: MoveTicket): Promise<void> {
		this.access.assertOwner(actor);
		await this.serialize(async () => {
			const current = await this.tickets.get(ticket.id);
			if (!current || current.archivedAt) throw new TicketError("ticket-conflict");
			if (input.beforeId) {
				const before = await this.tickets.get(input.beforeId);
				if (before?.id === ticket.id || before?.archivedAt || before?.status !== input.status)
					throw new TicketError("ticket-conflict");
			}
			const job = await this.record(ticket.id);
			if (job.state === "resetting") {
				if (input.status !== current.status) throw new TicketError("ticket-conflict");
				await this.store.save(job, input);
				return;
			}
			if (input.status === current.status) {
				await this.store.save(job, input);
			} else if (current.status === "backlog" && input.status === "todo") {
				const repositoryId = current.repositoryIds[0];
				if (!repositoryId) throw new TicketError("ticket-conflict");
				await this.requireExecutionRepository(actor, repositoryId);
				await this.store.save(
					{
						...job,
						phase: this.initialPhase(current, job),
						approvedRevision: job.plan?.revision,
						state: "queued",
					},
					input,
				);
			} else if (
				(input.status === "backlog" || (input.status === "todo" && current.status === "in-progress"))
				&& this.canReturnToBacklog(current, job)
			) {
				if (
					job.workspaceId
					&& job.resultSha
					&& (await this.merges.isMerged(actor, job.workspaceId, job.resultSha))
				) {
					// Recover a completed Git update before accepting a destructive reset.
					await this.store.save({ ...job, state: "idle", message: undefined }, { status: "done" });
					this.wake();
					throw new TicketError("ticket-conflict");
				}
				const abandonment = {
					workspaceId: job.workspaceId,
					plannerId: job.plannerId,
					implementerId: job.implementerId,
				};
				const hasResources = Object.values(abandonment).some(Boolean);
				const next: TicketWorkflowRecord = {
					ticketId: job.ticketId,
					plan: job.plan,
					phase: input.status === "todo" ? this.initialPhase(current, job) : "planning",
					mergeAttempts: 0,
					approvedRevision: !hasResources && input.status === "todo" ? job.plan?.revision : undefined,
					state: hasResources ? "resetting" : input.status === "todo" ? "queued" : "idle",
					...(hasResources ? { abandonment, resetStage: "stopping" as const } : {}),
				};
				await this.store.save(next, input);
				if (hasResources) void this.reset(actor, next);
			} else {
				throw new TicketError("ticket-conflict");
			}
		});
		this.wake();
	}
	async clearPlan(actor: Actor, ticket: Ticket): Promise<TicketWorkflow> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const current = await this.tickets.get(ticket.id);
			const job = await this.record(ticket.id);
			if (!current || current.archivedAt || current.status !== "backlog" || job.state === "resetting")
				throw new TicketError("ticket-conflict");
			const next: TicketWorkflowRecord = { ...job, plan: undefined, approvedRevision: undefined };
			await this.store.save(next);
			return this.summary(next);
		});
	}
	async capabilities(actor: Actor, ticket: Ticket): Promise<Pick<Ticket, "canReturnToBacklog" | "resetting">> {
		this.access.assertOwner(actor);
		if (ticket.archivedAt || ticket.status === "done") return {};
		const job = await this.record(ticket.id);
		if (job.state === "resetting") return { resetting: true };
		return this.canReturnToBacklog(ticket, job) ? { canReturnToBacklog: true } : {};
	}
	private canReturnToBacklog(ticket: Ticket, job: TicketWorkflowRecord): boolean {
		return ["todo", "in-progress"].includes(ticket.status) && !ticket.archivedAt && job.state !== "resetting";
	}
	async get(actor: Actor, id: string): Promise<TicketWorkflow> {
		this.access.assertOwner(actor);
		if (!(await this.tickets.get(id))) throw new TicketError("ticket-not-found");
		return this.summary(await this.record(id));
	}
	async boardSummary(actor: Actor): Promise<Map<string, Pick<Ticket, "agentStatus" | "needsAttention">>> {
		this.access.assertOwner(actor);
		const jobs = await this.store.boardSummary();
		const entries = await Promise.all(
			jobs.map(async (job) => {
				const flags: Pick<Ticket, "agentStatus" | "needsAttention"> = {};
				if (
					["setup-failed", "failed", "uncertain"].includes(job.state)
					|| (job.state === "idle" && (job.phase === "review" || (job.phase === "planning" && job.plan)))
				) {
					flags.needsAttention = true;
				} else if (this.settingUp.has(job.ticketId)) {
					flags.agentStatus = "working";
				} else if (job.state === "queued") {
					flags.agentStatus = "queued";
				} else if (job.state === "dispatching") {
					flags.agentStatus = "working";
				} else if (job.state === "running") {
					const id = job.phase === "planning" ? job.plannerId : job.implementerId;
					try {
						if (!id) throw new TicketError("ticket-unavailable");
						const { thread } = await this.agents.get(actor, id);
						if (thread.status === "waiting") flags.needsAttention = true;
						else flags.agentStatus = "working";
					} catch (err) {
						this.log.error({ err, ticketId: job.ticketId }, "Ticket agent status unavailable");
						flags.needsAttention = true;
					}
				}
				return [job.ticketId, flags] as const;
			}),
		);
		return new Map(entries);
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
	async message(actor: Actor, ticket: Ticket, text: string, expectedTurnId?: string): Promise<TicketWorkflow> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const job = await this.inProgress(ticket.id);
			const threadId = job.phase === "planning" ? job.plannerId : job.implementerId;
			if (expectedTurnId) {
				if (
					!threadId
					|| !["implementation", "rebase"].includes(job.phase)
					|| job.state !== "running"
					|| job.turnId !== expectedTurnId
					|| !text.trim()
					|| text.length > 8000
				)
					throw new TicketError("ticket-conflict");
				await this.agents.steer(actor, threadId, expectedTurnId, text.trim());
				return this.summary(job);
			}
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
		await this.processResets(actor);
		return this.serialize(async () => {
			for (const job of await this.store.list()) {
				const ticket = await this.tickets.get(job.ticketId);
				if (!ticket || ticket.archivedAt || ticket.status === "backlog" || ticket.status === "done") continue;
				try {
					if (["running", "uncertain", "dispatching"].includes(job.state)) await this.observe(actor, job);
					else if (job.state === "merge-queued") await this.merge(actor, job);
					else if (job.state === "queued" && this.canDispatch(ticket)) {
						if (ticket.status === "todo") {
							const occupied = (await this.tickets.list()).filter(
								(item) => !item.archivedAt && item.status === "in-progress",
							).length;
							if (occupied >= this.maxConcurrentTickets()) continue;
							await this.store.save(job, { status: "in-progress" });
							ticket.status = "in-progress";
						}
						await this.dispatch(actor, ticket, job);
					}
				} catch (err) {
					if (err instanceof AgentError && err.code === "agent-capacity") {
						if (job.state === "dispatching") await this.store.save({ ...job, state: "queued" });
						continue;
					}
					this.log.error({ err, ticketId: ticket.id }, "Ticket execution needs attention");
					const setupFailed =
						job.state === "queued"
						|| err instanceof AgentCatalogError
						|| (err instanceof AgentError && err.code === "unsupported-settings");
					const state = setupFailed ? "setup-failed" : job.state === "dispatching" ? "uncertain" : "failed";
					await this.store.save({ ...job, state });
				}
			}
		});
	}
	async recover(actor: Actor, ticketId?: string): Promise<void> {
		this.access.assertOwner(actor);
		await this.processResets(actor, ticketId);
		return this.serialize(async () => {
			if (ticketId) {
				const ticket = await this.tickets.get(ticketId);
				if (!ticket) throw new TicketError("ticket-not-found");
				if (ticket.archivedAt) throw new TicketError("ticket-conflict");
			}
			if (!ticketId) {
				for (const job of await this.store.pendingCleanup()) await this.cleanup(actor, job);
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
					const { thread } = await this.agents.get(actor, id);
					if (["interrupted", "failed"].includes(thread.status)) {
						await this.store.save({ ...job, state: "failed" });
						continue;
					}
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
		const job = await this.record(id);
		if (job.state === "resetting") throw new TicketError("ticket-conflict");
		return job;
	}
	private async processResets(actor: Actor, ticketId?: string): Promise<void> {
		const jobs = ticketId ? [await this.record(ticketId)] : await this.store.list();
		for (const job of jobs) {
			if (job.state !== "resetting") continue;
			const pending = this.reset(actor, job);
			if (ticketId) await pending;
		}
	}
	private reset(actor: Actor, job: TicketWorkflowRecord): Promise<void> {
		const existing = this.resetting.get(job.ticketId);
		if (existing) return existing;
		const pending = this.finishReset(actor, job)
			.catch((err: unknown) => {
				this.log.error({ err, ticketId: job.ticketId }, "Could not persist ticket cleanup progress");
			})
			.finally(() => this.resetting.delete(job.ticketId));
		this.resetting.set(job.ticketId, pending);
		return pending;
	}
	private async finishReset(actor: Actor, job: TicketWorkflowRecord): Promise<void> {
		try {
			const abandoned = job.abandonment;
			if (job.resetStage !== "cleanup") {
				const ids = [abandoned?.plannerId, abandoned?.implementerId].filter((id): id is string => !!id);
				if (!(await this.agents.stopTicket(actor, ids))) return;
				job = { ...job, resetStage: "cleanup", resetError: undefined };
				await this.serialize(() => this.store.save(job));
			}
			if (abandoned?.workspaceId) {
				if (!this.abandonmentCleanup) throw new TicketError("ticket-unavailable");
				await this.abandonmentCleanup.cleanupAbandoned(actor, abandoned.workspaceId);
			}
			await this.serialize(async () => {
				const ticket = await this.tickets.get(job.ticketId);
				const ready = ticket?.status === "todo";
				await this.store.save({
					ticketId: job.ticketId,
					plan: job.plan,
					mergeAttempts: 0,
					phase: ready && ticket ? this.initialPhase(ticket, job) : "planning",
					approvedRevision: ready ? job.plan?.revision : undefined,
					state: ready ? "queued" : "idle",
				});
			});
			this.wake();
		} catch (err) {
			this.log.error({ err, ticketId: job.ticketId }, "Abandoned ticket cleanup is pending");
			await this.serialize(() =>
				this.store.save({
					...job,
					resetError: "Could not finish cancellation or cleanup. Will retry automatically.",
				}),
			);
		}
	}
	private summary({
		previousTurnId: _previous,
		turnId: _turn,
		workspaceCleaned: _cleaned,
		cleanupFailed: _cleanupFailed,
		abandonment: _abandonment,
		...workflow
	}: TicketWorkflowRecord): TicketWorkflow {
		return workflow;
	}
	private canDispatch(ticket: Ticket): boolean {
		const mode = this.dispatchMode();
		return mode === "running" || (mode === "paused" && ticket.status === "in-progress");
	}
	private async requireExecutionRepository(actor: Actor, id: string): Promise<void> {
		try {
			await this.agents.assertRepositoryReady(actor, id);
		} catch (cause) {
			throw new TicketError("ticket-conflict", { cause });
		}
	}
	private async dispatch(actor: Actor, ticket: Ticket, job: TicketWorkflowRecord): Promise<void> {
		const current = await this.tickets.get(ticket.id);
		if (!current || current.archivedAt) throw new TicketError("ticket-conflict");
		if (!job.plannerId && !job.implementerId) {
			job.phase = this.initialPhase(current, job);
			job.approvedRevision = job.plan?.revision;
		}
		const repositoryId = job.executionRepositoryId ?? current.repositoryIds[0];
		if (!repositoryId) throw new TicketError("ticket-conflict");
		await this.requireExecutionRepository(actor, repositoryId);
		if (!job.executionRepositoryId) {
			job.executionRepositoryId = repositoryId;
			await this.store.save(job);
		}
		const { model, reasoningEffort, permissions } = current.executionSettings ?? {};
		const settings = { model, reasoningEffort, permissions };
		const planning = job.phase === "planning";
		let id = planning ? job.plannerId : job.implementerId;
		this.settingUp.add(ticket.id);
		try {
			if (!id) {
				const view = await this.agents.createTicketThread(
					actor,
					repositoryId,
					`${ticket.id} ${planning ? "planning" : "implementation"}`,
					job.workspaceId,
					async (workspaceId) => {
						job.workspaceId = workspaceId;
						await this.store.save(job);
					},
				);
				id = view.thread.id;
				if (planning) {
					job.plannerId = id;
					job.workspaceId = view.thread.workspaceId;
				} else {
					job.implementerId = id;
					job.workspaceId = view.thread.workspaceId;
				}
			}
			if (!job.baseSha && job.workspaceId) job.baseSha = await this.merges.base(actor, job.workspaceId);
			job.previousTurnId = (await this.agents.get(actor, id)).thread.turnId;
			job.turnId = undefined;
			job.state = "dispatching";
			await this.store.save(job);
			const view = await this.agents.dispatch(
				actor,
				id,
				this.prompts.build(current, job),
				{ ticketId: ticket.id, phase: job.phase },
				() => this.canDispatch(ticket),
				settings,
			);
			job.state = "running";
			job.turnId = view.thread.turnId;
			await this.store.save(job);
		} finally {
			this.settingUp.delete(ticket.id);
		}
	}
	private initialPhase(ticket: Ticket, job: TicketWorkflowRecord): "planning" | "implementation" {
		return job.plan || ticket.executionSettings?.skipPlanning ? "implementation" : "planning";
	}
	private async observe(actor: Actor, job: TicketWorkflowRecord): Promise<void> {
		const id = job.phase === "planning" ? job.plannerId : job.implementerId;
		if (!id) return;
		const { thread } = await this.agents.get(actor, id);
		if (thread.status === "uncertain") {
			await this.store.save({ ...job, state: "uncertain" });
			return;
		}
		if (["interrupted", "failed"].includes(thread.status)) {
			await this.store.save({ ...job, state: "failed" });
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
			const done = { ...job, state: "idle" as const, message: undefined };
			await this.store.save(done, { status: "done" });
			await this.cleanup(actor, done);
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
	private async cleanup(actor: Actor, job: TicketWorkflowRecord): Promise<void> {
		if (!job.workspaceId || !job.resultSha || job.workspaceCleaned) return;
		const { workspaceId, resultSha } = job;
		try {
			if (job.cleanupFailed) {
				job = { ...job, cleanupFailed: undefined };
				await this.store.save(job);
			}
			await this.workspaceCleanup.cleanupMerged(actor, workspaceId, resultSha);
			await this.store.save({ ...job, workspaceCleaned: true });
		} catch (err) {
			await this.store.save({ ...job, cleanupFailed: true });
			this.log.error({ err, ticketId: job.ticketId }, "Merged ticket workspace cleanup is pending");
		}
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.catch(() => {});
		return result;
	}
}
