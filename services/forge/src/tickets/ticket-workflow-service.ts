import { createLogger } from "@forge/backend-infrastructure/logger";
import { resolveAgentSettings, type AgentOptions } from "@forge/contracts/agents";
import {
	ticketExecutionSettingsSchema,
	ticketPhaseSettings,
	ticketAgentId,
	resolveTicketWorkflowPreset,
	type TicketAgentPhase,
	type TicketExecutionSettings,
	type TicketAgentMetrics,
} from "@forge/contracts/tickets";
import type {
	BoardSettings,
	Ticket,
	CreateTicket,
	MoveTicket,
	TicketCheckpoint,
	TicketWorkflow,
} from "@forge/contracts/tickets";

import type { ITicketAgents } from "../agents/agent-service.ts";
import { AgentCatalogError, AgentError } from "../agents/errors.ts";
import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import { ModelProviderError } from "../model-providers/errors.ts";
import { type IModelProviderService } from "../model-providers/model-provider-service.ts";
import type { ITaskAgents } from "../task-agents/task-agent-service.ts";
import type { ITicketMergeClient } from "../workspaces/workspace-merge-client.ts";
import type {
	IMergedWorkspaceCleanup,
	IAbandonedWorkspaceCleanup,
	ITicketRecoveryWorkspace,
} from "../workspaces/workspace-service.ts";
import { capHandoffText, completionReportRequirements, parseCompletionReport } from "./completion-report.ts";
import { TicketError } from "./errors.ts";
import { parseTicketPlan } from "./ticket-plan-format.ts";
import {
	assignedSubtask,
	hasNextSubtask,
	cleanTicketAssignment,
	emergencyHandoverSteer,
	ticketFreshWorkPrompt,
	ticketFinalizationPrompt,
	type ITicketPrompts,
} from "./ticket-prompts.ts";
import type { ITicketStore } from "./ticket-store.ts";
import type { ITicketWorkflowStore } from "./ticket-workflow-store.ts";
import { ticketWorkflowSummary, type TicketWorkflowRecord } from "./types.ts";

export interface ITicketWorkflowService {
	agentMetrics(actor: Actor): Promise<TicketAgentMetrics>;
	update(actor: Actor, id: string, input: CreateTicket): Promise<void>;
	options(actor: Actor, ticketId?: string, phase?: TicketAgentPhase): Promise<AgentOptions>;
	validateSettings(actor: Actor, settings: TicketExecutionSettings): Promise<void>;
	settings(actor: Actor, ticket: Ticket, settings: TicketExecutionSettings): Promise<void>;
	/** Archives between scheduler operations. Active or unresolved execution and pending merges conflict. */
	archive(actor: Actor, ticket: Ticket, archivedAt: string): Promise<void>;
	move(actor: Actor, ticket: Ticket, input: MoveTicket): Promise<void>;
	clearPlan(actor: Actor, ticket: Ticket): Promise<TicketWorkflow>;
	capabilities(actor: Actor, ticket: Ticket): Promise<Pick<Ticket, "assignee" | "canReturnToBacklog" | "resetting">>;
	get(actor: Actor, id: string): Promise<TicketWorkflow>;
	boardSummary(actor: Actor): Promise<Map<string, Pick<Ticket, "agentStatus" | "needsAttention">>>;
	approve(actor: Actor, ticket: Ticket, revision: number): Promise<TicketWorkflow>;
	queueMerge(actor: Actor, ticket: Ticket): Promise<TicketWorkflow>;
	commitCheckpoint(actor: Actor, id: string): Promise<TicketCheckpoint>;
	mergeIntoMain(actor: Actor, id: string): Promise<{ workflow: TicketWorkflow; sha: string }>;
	message(
		actor: Actor,
		ticket: Ticket,
		text: string,
		expectedTurnId?: string,
		revision?: number,
	): Promise<TicketWorkflow>;
	tick(actor: Actor): Promise<void>;
	recover(actor: Actor, id?: string): Promise<void>;
}

export class TicketWorkflowService implements ITicketWorkflowService {
	private tail: Promise<unknown> = Promise.resolve();
	private readonly settingUp = new Set<string>();
	private readonly resetting = new Map<string, Promise<void>>();
	private readonly cleaning = new Set<string>();
	private readonly manualMerges = new Set<string>();
	private readonly log = createLogger(TicketWorkflowService.name);
	async agentMetrics(actor: Actor): Promise<TicketAgentMetrics> {
		this.access.assertOwner(actor);
		const providers = new Map<string, { providerId: string; running: number; reserved: number }>();
		const agents = new Map<string, { agentId: string; queued: number }>();
		for (const row of await this.store.metricsRows()) {
			const job = row.job;
			if (job?.reservation) {
				const count = providers.get(job.reservation) ?? {
					providerId: job.reservation,
					running: 0,
					reserved: 0,
				};
				count.reserved++;
				if (job.state === "running") count.running++;
				providers.set(job.reservation, count);
			}
			if (!["todo", "in-progress"].includes(row.status) || this.settingUp.has(row.id)) continue;
			if (
				job ? job.state !== "queued" || job.phase === "rebase" || job.phase === "review" : row.status !== "todo"
			)
				continue;
			const phase =
				!job || (!job.reservation && !job.plannerId && !job.implementerId)
					? this.initialPhase({ executionSettings: row.settings }, job)
					: job.phase === "planning"
						? "planning"
						: "implementation";
			const id =
				(job?.reservation && this.phaseSnapshot(job, phase)?.agentId) || ticketAgentId(row.settings, phase);
			if (!id) continue;
			const count = agents.get(id) ?? { agentId: id, queued: 0 };
			count.queued++;
			agents.set(id, count);
		}
		return { providers: [...providers.values()], agents: [...agents.values()] };
	}
	async options(actor: Actor, ticketId?: string, requestedPhase?: TicketAgentPhase): Promise<AgentOptions> {
		this.access.assertOwner(actor);
		try {
			const job = ticketId ? await this.store.get(ticketId) : undefined;
			const phase = requestedPhase ?? (job?.phase === "planning" || !job ? "planning" : "implementation");
			const threadId = phase === "planning" ? job?.plannerId : job?.implementerId;
			if (!threadId && this.providers && this.taskAgents && ticketId) {
				const ticket = await this.tickets.get(ticketId);
				const pin = job && this.phaseSnapshot(job, phase);
				const snapshot =
					pin
					?? (await this.taskAgents.resolve(
						actor,
						ticketAgentId(ticket?.executionSettings, phase),
						ticket?.executionSettings?.permissions,
					));
				return await this.providers.snapshotOptions(actor, snapshot.configuration);
			}
			return await this.agents.catalogOptions(actor, threadId);
		} catch (cause) {
			if (cause instanceof ModelProviderError) throw cause;
			throw new TicketError("ticket-unavailable", { cause });
		}
	}
	async validateSettings(actor: Actor, settings: TicketExecutionSettings): Promise<void> {
		this.access.assertOwner(actor);
		const parsed = ticketExecutionSettingsSchema.safeParse(settings);
		if (!parsed.success) throw new TicketError("invalid-request");
		if (this.taskAgents) {
			await this.validateAssignees(actor, parsed.data);
			return;
		}
		if (!resolveAgentSettings(await this.options(actor), parsed.data).supported)
			throw new TicketError("unsupported-settings");
	}
	async settings(actor: Actor, ticket: Ticket, settings: TicketExecutionSettings): Promise<void> {
		this.access.assertOwner(actor);
		const parsed = ticketExecutionSettingsSchema.safeParse(settings);
		if (!parsed.success) throw new TicketError("invalid-request");
		await this.serialize(async () => {
			const current = await this.tickets.get(ticket.id);
			if (!current || current.archivedAt || current.status !== "backlog")
				throw new TicketError("ticket-conflict");
			if ((await this.record(ticket.id)).state === "resetting") throw new TicketError("ticket-conflict");
			const job = await this.record(ticket.id);
			if (this.taskAgents) await this.validateAssignees(actor, parsed.data, current.executionSettings ?? {}, job);
			else if (!resolveAgentSettings(await this.options(actor, ticket.id), parsed.data).supported)
				throw new TicketError("unsupported-settings");
			await this.tickets.updateSettings(ticket.id, parsed.data);
		});
	}
	private async validateAssignees(
		actor: Actor,
		settings: TicketExecutionSettings,
		previous?: TicketExecutionSettings,
		job?: TicketWorkflowRecord,
		ready = false,
	) {
		if (settings.providerId || settings.model || settings.reasoningEffort || settings.implementation)
			throw new TicketError("invalid-request");
		for (const phase of ["planning", "implementation"] as const) {
			if (phase === "planning" && (resolveTicketWorkflowPreset(settings) === "one-shot" || job?.plan)) continue;
			const id = ticketAgentId(settings, phase);
			const changed = previous && id !== ticketAgentId(previous, phase);
			const pin = job && this.phaseSnapshot(job, phase);
			const thread = phase === "planning" ? job?.plannerId : job?.implementerId;
			if (changed && (pin || thread)) throw new TicketError("ticket-conflict");
			if (ready) {
				if (!id) throw new ModelProviderError("provider-required");
				continue;
			}
			if (
				settings.permissions === "approve-for-me"
				&& pin?.configuration.kind === "ollama"
				&& !(phase === "planning" && job?.phase !== "planning")
			)
				throw new TicketError("unsupported-settings");
			if (
				!pin
				&& !thread
				&& id
				&& (!previous
					|| changed
					|| (settings.permissions === "approve-for-me" && settings.permissions !== previous.permissions))
			) {
				try {
					await this.taskAgents!.resolve(actor, id, settings.permissions);
				} catch (cause) {
					if (!(cause instanceof ModelProviderError) || settings.permissions !== "approve-for-me")
						throw cause;
					await this.taskAgents!.resolve(actor, id);
					throw new TicketError("unsupported-settings");
				}
			}
		}
	}
	constructor(
		private readonly store: ITicketWorkflowStore,
		private readonly tickets: ITicketStore,
		private readonly agents: ITicketAgents,
		private readonly merges: ITicketMergeClient,
		private readonly workspaceCleanup: IMergedWorkspaceCleanup,
		private readonly prompts: ITicketPrompts,
		private readonly access: IAccessService,
		private readonly wake: () => void = () => {},
		private readonly dispatchMode: () => BoardSettings["dispatch"] = () => "running",
		private readonly abandonmentCleanup?: IAbandonedWorkspaceCleanup,
		private readonly providers?: IModelProviderService,
		private readonly taskAgents?: ITaskAgents,
		private readonly openAIQuotaExhausted: () => Promise<boolean> = async () => false,
		private readonly recoveryWorkspaces?: ITicketRecoveryWorkspace,
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
			const job = await this.mutableRecord(actor, ticket.id);
			if (["running", "dispatching", "uncertain", "merge-queued", "resetting"].includes(job.state))
				throw new TicketError("ticket-conflict");
			await this.tickets.archive(ticket.id, archivedAt);
		});
		this.wake();
	}
	async move(actor: Actor, ticket: Ticket, input: MoveTicket): Promise<void> {
		this.access.assertOwner(actor);
		await this.serialize(async () => {
			const job = await this.mutableRecord(actor, ticket.id);
			const current = await this.tickets.get(ticket.id);
			if (!current || current.archivedAt) throw new TicketError("ticket-conflict");
			if (input.beforeId) {
				const before = await this.tickets.get(input.beforeId);
				if (before?.id === ticket.id || before?.archivedAt || before?.status !== input.status)
					throw new TicketError("ticket-conflict");
			}
			if (job.state === "resetting") {
				if (input.status !== current.status) throw new TicketError("ticket-conflict");
				await this.store.save(job, input);
				return;
			}
			if (input.status === current.status) {
				await this.store.save(job, input);
			} else if (current.status === "backlog" && input.status === "todo") {
				if (this.taskAgents)
					await this.validateAssignees(actor, current.executionSettings ?? {}, undefined, job, true);
				else await this.validateSettings(actor, current.executionSettings ?? {});
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
					await this.store.save(
						{ ...job, reservation: undefined, state: "idle", message: undefined },
						{ status: "done" },
					);
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
					...(hasResources
						? {
								abandonment,
								reservation: job.reservation,
								planningProviderSnapshot: job.planningProviderSnapshot,
								implementationProviderSnapshot: job.implementationProviderSnapshot,
								resetStage: "stopping" as const,
							}
						: {}),
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
	async capabilities(
		actor: Actor,
		ticket: Ticket,
	): Promise<Pick<Ticket, "assignee" | "canReturnToBacklog" | "resetting">> {
		this.access.assertOwner(actor);
		const inactive = ticket.archivedAt || ticket.status === "done";
		const settings = ticket.executionSettings;
		const hasAssignment = settings?.plannerAgentId || settings?.implementerAgentId;
		if (inactive && !hasAssignment) return {};
		const job = await this.store.get(ticket.id);
		const phase =
			ticket.status === "done"
				? "implementation"
				: ticket.status === "backlog" || !job
					? this.initialPhase(ticket, job)
					: job.phase === "planning"
						? "planning"
						: "implementation";
		const assigneeId =
			(job && this.phaseSnapshot(job, phase)?.agentId)
			?? ticketAgentId(settings, phase)
			?? (ticket.status === "backlog" || inactive
				? ticketAgentId(settings, phase === "planning" ? "implementation" : "planning")
				: undefined);
		const agent = assigneeId ? await this.taskAgents?.get(actor, assigneeId) : undefined;
		const capabilities: Pick<Ticket, "assignee" | "canReturnToBacklog" | "resetting"> = {};
		if (agent)
			capabilities.assignee = {
				name: agent.name,
				avatarColour: agent.avatarColour,
				avatarSymbol: agent.avatarSymbol,
			};
		if (inactive) return capabilities;
		if (job?.state === "resetting") capabilities.resetting = true;
		else if (this.canReturnToBacklog(ticket, job)) capabilities.canReturnToBacklog = true;
		return capabilities;
	}
	private canReturnToBacklog(ticket: Ticket, job?: TicketWorkflowRecord): boolean {
		return ["todo", "in-progress"].includes(ticket.status) && !ticket.archivedAt && job?.state !== "resetting";
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
			const job = await this.inProgress(actor, ticket.id);
			if (
				job.phase !== "planning"
				|| !["idle", "failed"].includes(job.state)
				|| job.plan?.revision !== revision
				|| job.approvedRevision
			)
				throw new TicketError("ticket-conflict");
			const next: TicketWorkflowRecord = {
				...job,
				phase: "implementation",
				state: "queued",
				reservation: undefined,
				approvedRevision: revision,
				message: undefined,
			};
			await this.store.save(next);
			this.wake();
			return this.summary(next);
		});
	}
	async queueMerge(actor: Actor, ticket: Ticket): Promise<TicketWorkflow> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const job = await this.inProgress(actor, ticket.id);
			if (
				job.contextFailure
				|| job.completionFailure
				|| !job.resultSha
				|| !(
					(job.phase === "review" && job.state === "idle")
					|| (job.state === "failed" && job.mergeRetryEligible)
				)
			)
				throw new TicketError("ticket-conflict");
			const next: TicketWorkflowRecord = { ...job, state: "merge-queued", mergeAttempts: 0, message: undefined };
			await this.store.save(next);
			this.wake();
			return this.summary(next);
		});
	}
	async message(
		actor: Actor,
		ticket: Ticket,
		text: string,
		expectedTurnId?: string,
		revision?: number,
	): Promise<TicketWorkflow> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const job = await this.inProgress(actor, ticket.id);
			if (
				revision !== undefined
				&& (job.phase !== "planning" || job.plan?.revision !== revision || job.approvedRevision)
			)
				throw new TicketError("ticket-conflict");
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
				completionFailure: undefined,
				reportRetrySourceTurnId: undefined,
				mergeRetryEligible: undefined,
				...(job.completionFailure && job.context
					? {
							context: {
								prompt: job.context.prompt,
								handover: job.context.handover,
								previousSubtaskSummary: job.context.previousSubtaskSummary,
								stage: "work" as const,
							},
						}
					: {}),
				...(job.contextFailure
					? {
							implementerId: undefined,
							previousImplementerIds: [
								...(job.previousImplementerIds ?? []),
								...(job.implementerId ? [job.implementerId] : []),
							],
							turnId: undefined,
							previousTurnId: undefined,
							contextFailure: undefined,
							context: job.context && {
								prompt: job.context.prompt,
								handover: job.context.handover,
								previousSubtaskSummary: job.context.previousSubtaskSummary,
								stage: "work" as const,
							},
						}
					: {}),
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
		for (const job of await this.store.pendingCleanup(true)) this.scheduleManualCleanup(actor, job);
		return this.serialize(async () => {
			let quota: Promise<boolean> | undefined;
			const quotaExhausted = () => (quota ??= this.openAIQuotaExhausted());
			for (const job of await this.store.list()) {
				if (job.manualMergeSha) {
					await this.reconcileManualMerge(actor, job).catch((err: unknown) => {
						this.log.error({ err, ticketId: job.ticketId }, "Manual merge recovery is pending");
					});
					continue;
				}
				let ticket = await this.tickets.get(job.ticketId);
				if (!ticket || ticket.archivedAt || ticket.status === "backlog" || ticket.status === "done") continue;
				if (job.state === "queued") {
					if (!this.canDispatch(ticket)) continue;
					const admitted = await this.admit(actor, ticket, job, quotaExhausted);
					if (!admitted) continue;
					ticket = admitted;
				}
				try {
					if (["running", "uncertain", "dispatching"].includes(job.state)) await this.observe(actor, job);
					else if (job.state === "merge-queued") await this.merge(actor, job);
					else if (job.state === "queued") await this.dispatch(actor, ticket, job);
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
					await this.store.save({
						...job,
						state,
						...(job.state === "merge-queued" && job.resultSha ? { mergeRetryEligible: true as const } : {}),
						providerSelectionError: err instanceof ModelProviderError || undefined,
					});
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
				for (const job of await this.store.pendingCleanup()) {
					if (job.manualCleanupThreads) this.scheduleManualCleanup(actor, job);
					else await this.cleanup(actor, job);
				}
			}
			const selected = ticketId ? [await this.record(ticketId)] : await this.store.list();
			for (const job of selected) {
				if (job.manualMergeSha) {
					await this.reconcileManualMerge(actor, job).catch((err: unknown) => {
						if (ticketId) throw err;
						this.log.error({ err, ticketId: job.ticketId }, "Manual merge recovery is pending");
					});
					continue;
				}
				if (job.manualCleanupThreads) {
					this.scheduleManualCleanup(actor, job);
					continue;
				}
				if (ticketId && job.cleanupFailed && (await this.tickets.get(job.ticketId))?.status === "done") {
					await this.cleanup(actor, job);
					continue;
				}
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
						await this.observe(actor, job);
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
	private async mutableRecord(actor: Actor, id: string): Promise<TicketWorkflowRecord> {
		const job = await this.record(id);
		if (!job.manualMergeSha) return job;
		const current = await this.reconcileManualMerge(actor, job);
		if (current.manualCleanupThreads) throw new TicketError("ticket-conflict");
		return current;
	}
	private async inProgress(actor: Actor, id: string): Promise<TicketWorkflowRecord> {
		const ticket = await this.tickets.get(id);
		if (!ticket) throw new TicketError("ticket-not-found");
		if (ticket.archivedAt || ticket.status !== "in-progress") throw new TicketError("ticket-conflict");
		const job = await this.mutableRecord(actor, id);
		if (job.state === "resetting") throw new TicketError("ticket-conflict");
		return job;
	}
	async commitCheckpoint(actor: Actor, id: string): Promise<TicketCheckpoint> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const job = await this.inProgress(actor, id);
			if (!job.workspaceId || !this.recoveryWorkspaces) throw new TicketError("ticket-workspace-invalid");
			return this.recoveryWorkspaces.withTicketWrite(actor, job.workspaceId, (_, checkpoint) =>
				checkpoint(`Checkpoint ${job.ticketId}`),
			);
		});
	}
	async mergeIntoMain(actor: Actor, id: string): Promise<{ workflow: TicketWorkflow; sha: string }> {
		this.access.assertOwner(actor);
		if (this.manualMerges.has(id)) throw new TicketError("ticket-conflict");
		this.manualMerges.add(id);
		try {
			return await this.serialize(async () => {
				const job = await this.inProgress(actor, id);
				const { workspaceId } = job;
				if (!workspaceId || !this.recoveryWorkspaces) throw new TicketError("ticket-workspace-invalid");
				return this.recoveryWorkspaces.withTicketWrite(actor, workspaceId, async (location) => {
					const sha = await this.merges.candidate(actor, workspaceId, location);
					const intent = { ...job, manualMergeSha: sha };
					await this.store.save(intent);
					try {
						if ((await this.merges.merge(actor, workspaceId, sha, location)) === "rebase")
							throw new TicketError("ticket-branch-diverged");
					} catch (cause) {
						if (cause instanceof TicketError && cause.code !== "ticket-unavailable")
							await this.clearManualMerge(intent);
						throw cause;
					}
					return { workflow: this.summary(await this.completeManualMerge(intent, sha)), sha };
				});
			});
		} finally {
			this.manualMerges.delete(id);
		}
	}
	private async reconcileManualMerge(actor: Actor, job: TicketWorkflowRecord): Promise<TicketWorkflowRecord> {
		if (!job.workspaceId || !job.manualMergeSha || !this.recoveryWorkspaces)
			throw new TicketError("ticket-unavailable");
		const repository = await this.recoveryWorkspaces
			.ticketRepository(actor, job.workspaceId)
			.catch((cause: unknown) => {
				throw new TicketError("ticket-unavailable", { cause });
			});
		if (await this.merges.isMerged(actor, job.workspaceId, job.manualMergeSha, repository))
			return this.completeManualMerge(job, job.manualMergeSha);
		return this.clearManualMerge(job);
	}
	private async clearManualMerge(job: TicketWorkflowRecord): Promise<TicketWorkflowRecord> {
		const next: TicketWorkflowRecord = {
			...job,
			manualMergeSha: undefined,
			...(job.state === "merge-queued" ? { state: "failed", mergeRetryEligible: true } : {}),
		};
		await this.store.save(next);
		return next;
	}
	private async completeManualMerge(job: TicketWorkflowRecord, sha: string): Promise<TicketWorkflowRecord> {
		const mayBeLive = !!job.reservation || ["running", "dispatching", "uncertain", "failed"].includes(job.state);
		const done: TicketWorkflowRecord = {
			...job,
			state: "idle",
			message: undefined,
			mergeRetryEligible: undefined,
			manualMergeSha: undefined,
			resultSha: sha,
			manualCleanupThreads: mayBeLive
				? [job.plannerId, job.implementerId, ...(job.previousImplementerIds ?? [])].filter(
						(id) => id !== undefined,
					)
				: [],
		};
		await this.store.save(done, { status: "done" });
		this.wake();
		return done;
	}
	private scheduleManualCleanup(actor: Actor, job: TicketWorkflowRecord): void {
		const { ticketId } = job;
		if (!job.manualCleanupThreads || job.workspaceCleaned || this.cleaning.has(ticketId)) return;
		this.cleaning.add(ticketId);
		void (async () => {
			const { manualCleanupThreads, workspaceCleaned } = await this.record(ticketId);
			if (!manualCleanupThreads || workspaceCleaned) return;
			if (manualCleanupThreads.length && !(await this.agents.stopTicket(actor, manualCleanupThreads))) return;
			const settled = await this.serialize(async () => {
				const current = await this.record(ticketId);
				const settled = { ...current, reservation: undefined, manualCleanupThreads: [] };
				if (current.reservation || current.manualCleanupThreads?.length) await this.store.save(settled);
				return settled;
			});
			await this.cleanup(actor, settled, (changes) =>
				this.serialize(async () => {
					await this.store.save({ ...(await this.record(ticketId)), ...changes });
				}),
			);
		})()
			.catch((err: unknown) => this.log.error({ err, ticketId }, "Manual merge cleanup is pending"))
			.finally(() => this.cleaning.delete(ticketId));
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
				job = { ...job, reservation: undefined, resetStage: "cleanup", resetError: undefined };
				await this.serialize(() => this.store.save(job));
				this.wake();
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
	private summary(job: TicketWorkflowRecord): TicketWorkflow {
		return ticketWorkflowSummary(job);
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
	private async admit(
		actor: Actor,
		ticket: Ticket,
		job: TicketWorkflowRecord,
		quotaExhausted: () => Promise<boolean>,
	): Promise<Ticket | undefined> {
		const next = { ...job, providerSelectionError: undefined };
		if (!next.reservation && !next.plannerId && !next.implementerId) {
			next.phase = this.initialPhase(ticket, next);
			next.approvedRevision = next.plan?.revision;
		}
		if (this.taskAgents && !next.reservation) {
			const phase = next.phase === "planning" ? "planning" : "implementation";
			const snapshotKey = phase === "planning" ? "planningProviderSnapshot" : "implementationProviderSnapshot";
			const id = ticketAgentId(ticket.executionSettings, phase);
			let usable = false;
			for await (const option of this.taskAgents.candidates(actor, id, ticket.executionSettings?.permissions)) {
				if (
					!usable
					&& id
					&& option.agentLimit !== null
					&& (await this.store.countAgentReservations(id)) >= option.agentLimit
				)
					return undefined;
				usable = true;
				if ((await this.store.countReservations(option.providerId)) >= option.limit) continue;
				if (option.snapshot.configuration.kind === "openai" && (await quotaExhausted())) continue;
				next[snapshotKey] = option.snapshot;
				next.reservation = option.providerId;
				break;
			}
			if (!this.canDispatch(ticket)) return undefined;
			if (!next.reservation) {
				if (!usable) await this.store.save({ ...next, state: "setup-failed", providerSelectionError: true });
				return undefined;
			}
		}
		const starting = ticket.status === "todo";
		if (starting || next.reservation !== job.reservation) {
			next.executionRepositoryId ??= ticket.repositoryIds.at(0);
			await this.store.save(next, starting ? { status: "in-progress" } : undefined);
		}
		Object.assign(job, next);
		return starting ? { ...ticket, status: "in-progress" } : ticket;
	}
	private async dispatch(actor: Actor, current: Ticket, job: TicketWorkflowRecord): Promise<void> {
		const phase = job.phase === "planning" ? "planning" : "implementation";
		const snapshotKey = phase === "planning" ? "planningProviderSnapshot" : "implementationProviderSnapshot";
		const repositoryId = job.executionRepositoryId ?? current.repositoryIds[0];
		if (!repositoryId) throw new TicketError("ticket-conflict");
		await this.requireExecutionRepository(actor, repositoryId);
		if (!job.executionRepositoryId) {
			job.executionRepositoryId = repositoryId;
			await this.store.save(job);
		}
		const { model, reasoningEffort, permissions } = ticketPhaseSettings(current.executionSettings, phase);
		const pin = job[snapshotKey];
		const settings =
			this.taskAgents && pin
				? { model: pin.model, reasoningEffort: pin.reasoningEffort, permissions }
				: { model, reasoningEffort, permissions };
		if (!resolveAgentSettings(await this.options(actor, current.id, phase), settings).supported)
			throw new TicketError("unsupported-settings");
		const planning = job.phase === "planning";
		const checkpoint = job.context?.stage === "report";
		const finalizing = checkpoint || !!job.reportRetrySourceTurnId;
		const requirements = completionReportRequirements(checkpoint, hasNextSubtask(current, job));
		let id = planning ? job.plannerId : job.implementerId;
		this.settingUp.add(current.id);
		try {
			if (!id) {
				const view = await this.agents.createTicketThread(
					actor,
					repositoryId,
					`${current.id} ${planning ? "planning" : "implementation"}`,
					job.workspaceId,
					async (workspaceId) => {
						job.workspaceId = workspaceId;
						await this.store.save(job);
					},
					job[snapshotKey],
					phase,
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
			if (checkpoint) {
				try {
					if (
						!job.workspaceId
						|| !job.context?.checkpoint
						|| !job.context.workTurn
						|| job.context.attempted !== job.context.workTurn
					)
						throw new Error("Checkpoint changed");
					await this.merges.verify(actor, job.workspaceId, job.context.checkpoint);
				} catch {
					await this.store.save({ ...job, state: "failed", contextFailure: "checkpoint" });
					return;
				}
			}
			if (finalizing) {
				const sourceTurn = job.reportRetrySourceTurnId ?? job.context?.workTurn;
				const sample = sourceTurn && (await this.agents.contextSample?.(actor, id, sourceTurn));
				const headroom = sample && sample.max !== undefined ? sample.max - sample.used : undefined;
				if (headroom === undefined ? checkpoint : headroom < 4096) {
					await this.store.save({
						...job,
						state: "failed",
						contextFailure: headroom === undefined ? "telemetry" : "headroom",
					});
					return;
				}
			}
			const priorTurn = (await this.agents.get(actor, id)).thread.turnId;
			const followUp = priorTurn || job.turnId || job.previousTurnId ? job.message?.trim() : undefined;
			let prompt: string;
			if (finalizing) {
				prompt = ticketFinalizationPrompt(requirements);
			} else if (job.phase === "implementation" || job.phase === "rebase") {
				const ordered = !!assignedSubtask(current, job);
				const recovery = followUp ? undefined : cleanTicketAssignment(job.message);
				// A fresh retry retains an owner message and the retired Implementer.
				// Handoffs and ordered advancement clear the message.
				const interrupted = !followUp && !!job.message && !!job.previousImplementerIds?.length;
				const assignment =
					(!ordered && recovery)
					|| (!ordered && cleanTicketAssignment(job.context?.prompt))
					|| cleanTicketAssignment(this.prompts.assignment(current, { ...job, message: undefined }))
					|| "";
				const boundedContext = (value: string | undefined) => {
					const cleaned = cleanTicketAssignment(value);
					return cleaned && capHandoffText(cleaned);
				};
				const handover = boundedContext(job.context?.handover);
				const summary = boundedContext(job.context?.previousSubtaskSummary);
				if (job.workspaceId) {
					job.context = {
						prompt: assignment,
						handover,
						previousSubtaskSummary: summary,
						baseline: await this.merges.head(actor, job.workspaceId),
						stage: "work",
					};
				}
				prompt =
					followUp
					?? ticketFreshWorkPrompt(current, job, assignment, ordered ? recovery : undefined, interrupted);
			} else {
				prompt = this.prompts.planning(current, job);
			}
			job.previousTurnId = priorTurn;
			if (job.phase === "rebase" && !job.reportRetrySourceTurnId) job.mergeRetryEligible = undefined;
			job.turnId = undefined;
			job.state = "dispatching";
			await this.store.save(job);
			const view = await this.agents.dispatch(
				actor,
				id,
				prompt,
				{ ticketId: current.id, phase: job.phase },
				() => this.canDispatch(current),
				pin?.model ? { ...settings, pinned: true } : settings,
			);
			job.state = "running";
			job.turnId = view.thread.turnId;
			await this.store.save(job);
		} finally {
			this.settingUp.delete(current.id);
		}
	}
	private phaseSnapshot(job: TicketWorkflowRecord, phase: TicketAgentPhase) {
		return phase === "planning" ? job.planningProviderSnapshot : job.implementationProviderSnapshot;
	}
	private initialPhase(
		ticket: Pick<Ticket, "executionSettings">,
		job?: TicketWorkflowRecord,
	): "planning" | "implementation" {
		return job?.plan || resolveTicketWorkflowPreset(ticket.executionSettings) === "one-shot"
			? "implementation"
			: "planning";
	}
	private async observe(actor: Actor, job: TicketWorkflowRecord): Promise<void> {
		const id = job.phase === "planning" ? job.plannerId : job.implementerId;
		if (!id) return;
		const work = job.phase === "implementation" || job.phase === "rebase";
		if (work && !job.context) {
			const ticket = await this.tickets.get(job.ticketId);
			if (!ticket) throw new TicketError("ticket-not-found");
			job.context = { prompt: this.prompts.assignment(ticket, job), stage: "work" };
			await this.store.save(job);
		}
		const { thread, requests, turnFailure } = await this.agents.get(actor, id);
		const checkpoint = job.context?.stage === "report";
		const finalizing = checkpoint || !!job.reportRetrySourceTurnId;
		if (thread.status === "uncertain") {
			await this.store.save({ ...job, state: "uncertain" });
			return;
		}
		if (["interrupted", "failed"].includes(thread.status)) {
			const sample =
				!finalizing && job.context?.stage === "work" && thread.turnId
					? await this.agents.contextSample?.(actor, id, thread.turnId)
					: undefined;
			const contextFailure =
				finalizing && turnFailure === "context-window"
					? ("headroom" as const)
					: checkpoint
						? ("report" as const)
						: job.context?.insufficient
							? ("headroom" as const)
							: !finalizing && job.context && !sample
								? ("telemetry" as const)
								: job.context?.attempted || sample?.crossed
									? ("report" as const)
									: undefined;
			await this.store.save({
				...job,
				state: "failed",
				...(job.reportRetrySourceTurnId && !contextFailure
					? { completionFailure: "invalid-report" as const, reportRetrySourceTurnId: undefined }
					: {}),
				contextFailure,
			});
			return;
		}
		if (!thread.turnId || thread.turnId === job.previousTurnId || (job.turnId && thread.turnId !== job.turnId)) {
			if (thread.status !== "running" && thread.status !== "waiting") {
				if (job.context?.stage === "report" && thread.turnId === job.previousTurnId)
					await this.store.save({ ...job, state: "failed", contextFailure: "report" });
				else await this.store.save({ ...job, state: "uncertain" });
			}
			return;
		}
		if (thread.status === "running" || thread.status === "waiting") {
			if (work && !finalizing && job.context?.stage === "work") {
				const sample = await this.agents.contextSample?.(actor, id, thread.turnId);
				const threshold = job.implementationProviderSnapshot?.configuration.compactionThresholdTokens;
				const crossed = threshold === undefined ? sample?.crossed : sample && sample.peak >= threshold;
				if (crossed && job.context.crossedTurnId !== thread.turnId) {
					job.context.crossedTurnId = thread.turnId;
					await this.store.save(job);
				}
				if (
					job.context.crossedTurnId === thread.turnId
					&& job.context.attempted !== thread.turnId
					&& thread.status === "running"
					&& !requests.length
				) {
					job.context.attempted = thread.turnId;
					await this.store.save(job);
					try {
						await this.agents.steer(actor, id, thread.turnId, emergencyHandoverSteer);
					} catch (err) {
						this.log.warn({ err, ticketId: job.ticketId }, "Checkpoint steer outcome is uncertain");
						await this.store.save({ ...job, state: "uncertain" });
						try {
							await this.agents.resume(actor, id);
						} catch (reconcileError) {
							this.log.warn(
								{ err: reconcileError, ticketId: job.ticketId },
								"Could not reconcile checkpoint turn",
							);
						}
						return;
					}
				}
			}
			if (job.state !== "running" || !job.turnId)
				await this.store.save({ ...job, state: "running", turnId: thread.turnId });
			return;
		}
		if (thread.status !== "completed") {
			await this.store.save({ ...job, state: "failed" });
			return;
		}
		const nextSubtask = job.phase === "implementation" && hasNextSubtask(await this.tickets.get(job.ticketId), job);
		let summary: string | undefined;
		if (work) {
			const report = parseCompletionReport(
				(await this.agents.finalAnswer?.(actor, id, thread.turnId)) ?? "",
				completionReportRequirements(checkpoint, nextSubtask),
			);
			if (!report) {
				if (finalizing) {
					await this.store.save({
						...job,
						state: "failed",
						completionFailure: "invalid-report",
						reportRetrySourceTurnId: undefined,
					});
					return;
				}
				if (job.context?.attempted === thread.turnId) {
					try {
						if (!job.workspaceId) throw new Error("Missing workspace");
						const sha = await this.merges.candidate(actor, job.workspaceId);
						job.context = { ...job.context, stage: "report", checkpoint: sha, workTurn: thread.turnId };
					} catch {
						await this.store.save({ ...job, state: "failed", contextFailure: "checkpoint" });
						return;
					}
				}
				await this.store.save({ ...job, state: "queued", reportRetrySourceTurnId: thread.turnId });
				this.wake();
				return;
			}
			job.reportRetrySourceTurnId = undefined;
			if (report.status === "incomplete") {
				await this.store.save({ ...job, state: "failed", completionFailure: "incomplete" });
				return;
			}
			if (checkpoint || report.status === "handoff") {
				let sha: string;
				try {
					if (!job.workspaceId) throw new Error("Missing workspace");
					sha = await this.merges.candidate(actor, job.workspaceId);
					if (checkpoint && sha !== job.context?.checkpoint) throw new Error("Checkpoint changed");
				} catch {
					await this.store.save({ ...job, state: "failed", contextFailure: "checkpoint" });
					return;
				}
				if (report.status === "handoff") {
					if (!job.context?.baseline || job.context.baseline === sha) {
						await this.store.save({ ...job, state: "failed", contextFailure: "no-progress" });
						return;
					}
					await this.store.save({
						...job,
						implementerId: undefined,
						previousImplementerIds: [...(job.previousImplementerIds ?? []), id],
						turnId: undefined,
						previousTurnId: undefined,
						message: undefined,
						state: "queued",
						context: {
							prompt: job.context.prompt,
							handover: report.handover,
							previousSubtaskSummary: job.context.previousSubtaskSummary,
							stage: "work",
						},
					});
					this.wake();
					return;
				}
			}
			if (report.status !== "complete") throw new TicketError("ticket-conflict");
			summary = report.summary;
		}
		if (job.phase === "planning") {
			const text = await this.agents.plan(actor, id, thread.turnId);
			const structured = text && parseTicketPlan(text);
			const preset = (await this.tickets.get(job.ticketId))?.executionSettings?.workflowPreset;
			if (
				!text
				|| !structured
				|| (preset === "planner-subtasks" && !structured.subtasks.length)
				|| (preset === "planner-implementer" && structured.subtasks.length > 0)
			) {
				this.log.warn({ ticketId: job.ticketId }, "Planner returned a missing or invalid plan");
				await this.store.save({ ...job, state: "failed" });
				return;
			}
			const plan = { revision: (job.plan?.revision ?? 0) + 1, text, structured };
			await this.store.save({ ...job, plan, state: "idle", message: undefined });
		} else {
			if (!job.workspaceId) throw new TicketError("ticket-conflict");
			if (nextSubtask) {
				await this.store.save({
					...job,
					subtaskIndex: (job.subtaskIndex ?? 0) + 1,
					context: { stage: "work", previousSubtaskSummary: summary },
					implementerId: undefined,
					previousImplementerIds: [...(job.previousImplementerIds ?? []), id],
					state: "queued",
					turnId: undefined,
					previousTurnId: undefined,
					message: undefined,
				});
				this.wake();
				return;
			}
			const resultSha = await this.merges.candidate(actor, job.workspaceId);
			if (resultSha === job.baseSha || resultSha === job.resultSha) throw new TicketError("ticket-conflict");
			// Persist the verified candidate before the nontransactional Git update.
			await this.store.save({
				...job,
				resultSha,
				context: undefined,
				state: job.phase === "review" ? "idle" : "merge-queued",
				message: undefined,
			});
			this.wake();
		}
	}
	private async merge(actor: Actor, job: TicketWorkflowRecord): Promise<void> {
		if (!job.workspaceId || !job.resultSha) throw new TicketError("ticket-conflict");
		if ((await this.merges.merge(actor, job.workspaceId, job.resultSha)) === "merged") {
			const done = { ...job, reservation: undefined, state: "idle" as const, message: undefined };
			await this.store.save(done, { status: "done" });
			await this.cleanup(actor, done);
			this.wake();
		} else {
			const exhausted = job.mergeAttempts >= 3;
			await this.store.save({
				...job,
				phase: "rebase",
				state: exhausted ? "failed" : "queued",
				mergeRetryEligible: exhausted ? true : undefined,
				mergeAttempts: Math.min(3, job.mergeAttempts + 1),
				message: undefined,
			});
			if (!exhausted) this.wake();
		}
	}
	private async cleanup(
		actor: Actor,
		job: TicketWorkflowRecord,
		saveProgress: (changes: Pick<TicketWorkflowRecord, "cleanupFailed" | "workspaceCleaned">) => Promise<void> = (
			changes,
		) => this.store.save({ ...job, ...changes }),
	): Promise<void> {
		if (!job.workspaceId || !job.resultSha || job.workspaceCleaned) return;
		const { workspaceId, resultSha } = job;
		try {
			if (job.cleanupFailed && !job.manualCleanupThreads) await saveProgress({ cleanupFailed: undefined });
			if (job.manualCleanupThreads)
				await this.workspaceCleanup.cleanupMerged(actor, workspaceId, resultSha, true);
			else await this.workspaceCleanup.cleanupMerged(actor, workspaceId, resultSha);
			await saveProgress({ cleanupFailed: undefined, workspaceCleaned: true });
		} catch (err) {
			if (job.cleanupFailed && job.manualCleanupThreads) return;
			await saveProgress({ cleanupFailed: true });
			this.log.error({ err, ticketId: job.ticketId }, "Merged ticket workspace cleanup is pending");
		}
	}
	/** Orders admission-affecting configuration writes with ticket transitions. */
	serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.catch(() => {});
		return result;
	}
}
