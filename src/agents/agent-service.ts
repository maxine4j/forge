import { createLogger } from "@forge/backend-infrastructure/logger";
import type { Workspace, CreateWorkspace, WorkspaceTree } from "@forge/contracts";
import {
	agentThreadSchema,
	createAgentSchema,
	agentMessageSchema,
	agentSettingsSchema,
	resolveAgentSettings,
	type AgentSettings,
	type AgentOptions,
	type AgentThread,
	type AgentView,
	type AgentReply,
} from "@forge/contracts/agents";
import { z } from "zod";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { ICodexAgentClient } from "../codex/codex-agent-client.ts";
import type { TicketUsageScope } from "../cost/types.ts";
import type { IProjectService } from "../projects/project-service.ts";
import type { WorkspaceLocation } from "../workspaces/types.ts";
import type { IAgentExecutionPool } from "./agent-execution-pool.ts";
import type { IAgentThreadStore } from "./agent-thread-store.ts";
import { AgentCatalogError, AgentError } from "./errors.ts";
import type { AgentThreadRecord } from "./types.ts";
export interface IAgentWorkspaces {
	get(actor: Actor, id: string): Promise<Workspace>;
	create(actor: Actor, projectId: string, input: CreateWorkspace): Promise<Workspace>;
	resolve(actor: Actor, id: string): Promise<WorkspaceLocation>;
	tree(actor: Actor, id: string, path: string): Promise<WorkspaceTree>;
}
export interface IAgentService {
	/** Owner-only. Creates a dedicated workspace; Codex identifiers stay private. Throws AgentError. */
	create(actor: Actor, projectId: string, title: string): Promise<AgentView>;
	list(actor: Actor, projectId: string): Promise<AgentThread[]>;
	get(actor: Actor, id: string): Promise<AgentView>;
	send(actor: Actor, id: string, text: string, settings?: AgentSettings): Promise<AgentView>;
	options(actor: Actor, id: string): Promise<AgentOptions>;
	files(actor: Actor, id: string, query: string): Promise<string[]>;
	resume(actor: Actor, id: string): Promise<AgentView>;
	interrupt(actor: Actor, id: string): Promise<AgentView>;
	reply(actor: Actor, id: string, input: AgentReply): Promise<AgentView>;
	subscribe(actor: Actor, id: string, listener: () => void): Promise<() => void>;
	shutdown(): Promise<void>;
}
export interface ITicketAgents {
	catalogOptions(actor: Actor): Promise<AgentOptions>;
	assertRepositoryReady(actor: Actor, id: string): Promise<void>;
	steer(actor: Actor, id: string, turnId: string, text: string): Promise<AgentView>;
	createTicketThread(
		actor: Actor,
		projectId: string,
		title: string,
		workspaceId?: string,
		reserveSlot?: boolean,
	): Promise<AgentView>;
	dispatch(
		actor: Actor,
		id: string,
		text: string,
		ticket: TicketUsageScope,
		allowed?: () => boolean,
		settings?: AgentSettings,
	): Promise<AgentView>;
	plan(actor: Actor, id: string, turnId: string): Promise<string | undefined>;
	get(actor: Actor, id: string): Promise<AgentView>;
	resume(actor: Actor, id: string): Promise<AgentView>;
}
export interface IAgentStop {
	/** Requests interruption for active reservations. Reports failures individually. */
	stopAll(actor: Actor): Promise<{ requested: number; recovered: number; failed: number }>;
}
export class AgentService implements IAgentService, ITicketAgents, IAgentStop {
	private readonly log = createLogger(AgentService.name);
	private readonly queues = new Map<string, Promise<unknown>>();
	private readonly identities = new Map<string, string>();
	private readonly listeners = new Map<string, Set<() => void>>();
	private readonly unsubscribe: () => void;
	private closed = false;
	private stopping = 0;
	private stopRevision = 0;
	constructor(
		private readonly store: IAgentThreadStore,
		private readonly client: ICodexAgentClient,
		private readonly workspaces: IAgentWorkspaces,
		private readonly projects: IProjectService,
		private readonly access: IAccessService,
		private readonly generateId: () => string,
		private readonly now: () => Date,
		private readonly pool: IAgentExecutionPool,
		private readonly defaults: () => Pick<AgentOptions, "defaultModel" | "defaultReasoningEffort"> = () => ({}),
	) {
		this.unsubscribe = client.subscribe((codexId) => {
			const id = this.identities.get(codexId);
			if (!id || this.closed) return;
			void this.serialize(id, async () => {
				await this.sync(await this.require(id));
				for (const listener of this.listeners.get(id) ?? []) listener();
			}).catch((err: unknown) => this.log.error({ err }, "Could not persist agent activity"));
		});
	}
	async create(actor: Actor, projectId: string, title: string): Promise<AgentView> {
		return this.createThread(actor, projectId, title, false);
	}
	async createTicketThread(
		actor: Actor,
		projectId: string,
		title: string,
		workspaceId?: string,
		reserveSlot = false,
	): Promise<AgentView> {
		return this.createThread(actor, projectId, title, true, workspaceId, reserveSlot);
	}
	async list(actor: Actor, projectId: string): Promise<AgentThread[]> {
		this.authorize(actor);
		await this.projects.get(actor, projectId);
		return (await this.store.list(projectId))
			.filter((record) => !record.managed)
			.map((record) => agentThreadSchema.parse(this.view(record).thread));
	}
	async get(actor: Actor, id: string): Promise<AgentView> {
		this.authorize(actor);
		return this.serialize(id, async () => this.view(await this.require(id)));
	}
	async options(actor: Actor, id: string): Promise<AgentOptions> {
		this.authorize(actor);
		const record = await this.require(id);
		const location = await this.workspaces.resolve(actor, record.workspaceId);
		return { ...(await this.client.options(location.path)), ...this.defaults() };
	}
	async catalogOptions(actor: Actor): Promise<AgentOptions> {
		this.authorize(actor);
		return { ...(await this.client.options()), ...this.defaults() };
	}
	async assertRepositoryReady(actor: Actor, id: string): Promise<void> {
		this.authorize(actor);
		if ((await this.projects.get(actor, id)).status !== "ready") throw new AgentError("agent-conflict");
	}
	async files(actor: Actor, id: string, query: string): Promise<string[]> {
		this.authorize(actor);
		if (query.length > 500) throw new AgentError("invalid-request");
		const record = await this.require(id);
		const location = await this.workspaces.resolve(actor, record.workspaceId);
		if (!query) {
			const tree = await this.workspaces.tree(actor, record.workspaceId, "");
			return tree.entries
				.filter((entry) => entry.kind === "file")
				.slice(0, 100)
				.map((entry) => entry.path);
		}
		return this.client.files(location.path, query);
	}
	async send(actor: Actor, id: string, text: string, settings?: AgentSettings): Promise<AgentView> {
		this.authorize(actor);
		if (!agentMessageSchema.safeParse({ text, ...settings }).success) throw new AgentError("invalid-request");
		if ((await this.require(id)).managed) throw new AgentError("agent-conflict");
		return this.execute(actor, id, text, settings);
	}
	/** Ticket scheduler dispatch; the prompt is internal and can include a complete approved plan. */
	async dispatch(
		actor: Actor,
		id: string,
		text: string,
		ticket?: TicketUsageScope,
		allowed?: () => boolean,
		settings?: AgentSettings,
	): Promise<AgentView> {
		return this.execute(actor, id, text, settings ?? {}, ticket, allowed);
	}
	async steer(actor: Actor, id: string, turnId: string, text: string): Promise<AgentView> {
		this.authorize(actor);
		if (!agentMessageSchema.safeParse({ text }).success) throw new AgentError("invalid-request");
		return this.serialize(id, async () => {
			const record = await this.require(id);
			if (!record.managed || !record.codexId || record.turnId !== turnId || record.status !== "running")
				throw new AgentError("agent-conflict");
			const location = await this.workspaces.resolve(actor, record.workspaceId);
			if (location.workspace.projectId !== record.projectId) throw new AgentError("agent-conflict");
			await this.client.steer(record.codexId, turnId, text.trim(), location.path);
			return this.sync(record);
		});
	}
	async plan(actor: Actor, id: string, turnId: string): Promise<string | undefined> {
		this.authorize(actor);
		return this.serialize(id, async () => {
			const record = await this.require(id);
			if (!record.managed || !record.codexId) throw new AgentError("agent-conflict");
			const runtime = this.client.read(record.codexId);
			return runtime.status === "completed" && runtime.turnId === turnId ? runtime.plan : undefined;
		});
	}
	private async execute(
		actor: Actor,
		id: string,
		text: string,
		settings?: AgentSettings,
		ticket?: TicketUsageScope,
		allowed?: () => boolean,
	): Promise<AgentView> {
		this.authorize(actor);
		const input = z.object({ text: z.string().trim().min(1).max(64000) }).safeParse({ text });
		if (!input.success) throw new AgentError("invalid-request");
		const revision = this.stopRevision;
		const view = await this.serialize(id, async () => {
			const record = await this.require(id);
			if (this.stopping || revision !== this.stopRevision) {
				this.pool.observe(id, record.status);
				throw new AgentError("agent-capacity");
			}
			const previousStatus = record.status;
			if (["creating", "running", "waiting", "uncertain"].includes(record.status))
				throw new AgentError("agent-conflict");
			const selection = agentSettingsSchema.safeParse(
				settings ?? {
					model: record.model,
					reasoningEffort: record.reasoningEffort,
					permissions: record.permissions,
				},
			);
			if (!selection.success) throw new AgentError("invalid-request");
			const catalog = await this.client.options().catch((cause: unknown) => {
				this.pool.observe(id, previousStatus);
				throw new AgentCatalogError(cause);
			});
			const resolved = resolveAgentSettings({ ...catalog, ...this.defaults() }, selection.data);
			if (!resolved.supported) {
				this.pool.observe(id, previousStatus);
				throw new AgentError("unsupported-settings");
			}
			if (allowed && !allowed()) {
				this.pool.observe(id, record.status);
				throw new AgentError("agent-capacity");
			}
			this.pool.claim(id);
			record.model = selection.data.model;
			record.reasoningEffort = selection.data.reasoningEffort;
			record.permissions = selection.data.permissions;
			let contactedRuntime = false;
			try {
				const location = await this.workspaces.resolve(actor, record.workspaceId);
				contactedRuntime = true;
				if (record.codexId) {
					const runtime = await this.client.resume(record.codexId, location.path);
					this.identities.set(record.codexId, id);
					if (["creating", "running", "waiting", "uncertain"].includes(runtime.status))
						throw new AgentError("agent-conflict");
				}
				if (!record.codexId) {
					record.status = "creating";
					await this.store.update(record);
					record.codexId = await this.client.start(location.path);
					this.identities.set(record.codexId, id);
				}
				record.status = "running";
				await this.store.update(record);
				if (this.stopping || revision !== this.stopRevision || (allowed && !allowed())) {
					record.status = previousStatus;
					await this.store.update(record);
					this.pool.observe(id, previousStatus);
					return undefined;
				}
				await this.client.send(
					record.codexId,
					location.path,
					input.data.text,
					{
						model: resolved.model?.id,
						reasoningEffort: resolved.reasoningEffort,
						permissions: selection.data.permissions,
					},
					ticket
						? { projectId: record.projectId, ...ticket }
						: record.managed
							? undefined
							: { projectId: record.projectId, phase: "chat" },
				);
				return await this.sync(record);
			} catch (cause) {
				if (!contactedRuntime) {
					this.pool.observe(id, record.status);
					throw cause;
				}
				record.status = "uncertain";
				this.pool.observe(id, "uncertain");
				await this.store.update(record);
				throw cause;
			}
		});
		if (!view) throw new AgentError("agent-capacity");
		return view;
	}
	async resume(actor: Actor, id: string): Promise<AgentView> {
		this.authorize(actor);
		return this.serialize(id, async () => {
			const record = await this.require(id);
			if (!record.codexId) {
				if (record.status === "idle") return this.view(record);
				throw new AgentError("agent-conflict");
			}
			if (record.managed && (await this.workspaces.get(actor, record.workspaceId)).status === "archived") {
				await this.client.loadHistory(record.codexId);
				this.identities.set(record.codexId, id);
				return this.view(record);
			}
			const location = await this.workspaces.resolve(actor, record.workspaceId);
			await this.client.resume(record.codexId, location.path);
			this.identities.set(record.codexId, id);
			return this.sync(record);
		});
	}
	async interrupt(actor: Actor, id: string): Promise<AgentView> {
		this.authorize(actor);
		return this.serialize(id, async () => {
			const record = await this.require(id);
			if (!record.codexId || !record.turnId || !["running", "waiting"].includes(record.status))
				throw new AgentError("agent-conflict");
			await this.client.interrupt(record.codexId, record.turnId);
			return this.sync(record);
		});
	}
	async stopAll(actor: Actor): Promise<{ requested: number; recovered: number; failed: number }> {
		this.authorize(actor);
		this.stopping++;
		this.stopRevision++;
		try {
			const results = await Promise.allSettled(
				this.pool.activeIds().map((id) =>
					this.serialize(id, async () => {
						const record = await this.require(id);
						if (!["creating", "uncertain", "running", "waiting"].includes(record.status)) {
							this.pool.observe(id, record.status);
							return { requested: 0, recovered: 0, failed: 0 };
						}
						const result = await this.reconcile(actor, record);
						if (result.state !== "active") return { requested: 0, recovered: 1, failed: 0 };
						await this.client.interrupt(record.codexId!, result.turnId);
						// An acknowledgment is not evidence of termination.
						try {
							if (
								["completed", "failed", "interrupted"].includes(
									this.client.read(record.codexId!).status,
								)
							) {
								await this.sync(await this.require(id));
								return { requested: 1, recovered: 1, failed: 0 };
							}
							const after = await this.reconcile(actor, await this.require(id));
							return {
								requested: 1,
								recovered: after.state === "active" ? 0 : 1,
								failed: after.state === "active" ? 1 : 0,
							};
						} catch {
							return { requested: 1, recovered: 0, failed: 1 };
						}
					}).catch((err: unknown) => {
						this.log.warn({ err, threadId: id }, "Could not interrupt agent");
						throw err;
					}),
				),
			);
			return {
				requested: results.reduce(
					(n, result) => n + (result.status === "fulfilled" ? result.value.requested : 0),
					0,
				),
				recovered: results.reduce(
					(n, result) => n + (result.status === "fulfilled" ? result.value.recovered : 0),
					0,
				),
				failed: results.reduce((n, result) => n + (result.status === "fulfilled" ? result.value.failed : 1), 0),
			};
		} finally {
			this.stopping--;
		}
	}
	async reply(actor: Actor, id: string, input: AgentReply): Promise<AgentView> {
		this.authorize(actor);
		return this.serialize(id, async () => {
			const record = await this.require(id);
			if (!record.codexId || record.status !== "waiting") throw new AgentError("agent-conflict");
			await this.workspaces.resolve(actor, record.workspaceId);
			this.client.reply(record.codexId, input);
			return this.sync(record);
		});
	}
	async subscribe(actor: Actor, id: string, listener: () => void): Promise<() => void> {
		this.authorize(actor);
		await this.require(id);
		const listeners = this.listeners.get(id) ?? new Set();
		this.listeners.set(id, listeners);
		listeners.add(listener);
		return () => {
			listeners.delete(listener);
			if (!listeners.size) this.listeners.delete(id);
		};
	}
	async shutdown(): Promise<void> {
		this.closed = true;
		this.unsubscribe();
		await Promise.allSettled([...this.queues.values()]);
		this.listeners.clear();
	}
	/** Reserve persisted active executions before HTTP accepts messages; no runtime RPCs. */
	async seed(actor: Actor): Promise<void> {
		this.authorize(actor);
		const records = (
			await Promise.all((await this.projects.list(actor)).map((project) => this.store.list(project.id)))
		).flat();
		for (const record of records) this.pool.observe(record.id, record.status);
	}
	/** Background reconciliation never replays a turn; unavailable runtimes retain slots. */
	async recover(actor: Actor): Promise<void> {
		this.authorize(actor);
		const records = (
			await Promise.all((await this.projects.list(actor)).map((project) => this.store.list(project.id)))
		).flat();
		for (const record of records) {
			if (record.status !== "uncertain") continue;
			try {
				await this.serialize(record.id, async () => this.reconcile(actor, await this.require(record.id)));
			} catch (err) {
				this.log.error({ err, threadId: record.id }, "Agent reconciliation failed; retaining execution slot");
			}
		}
	}
	private async reconcile(actor: Actor, record: AgentThreadRecord) {
		const path = record.codexId ? (await this.workspaces.resolve(actor, record.workspaceId)).path : undefined;
		const result = await this.client.reconcile(record.codexId, path);
		if (result.state === "unavailable") throw new AgentError("agent-unavailable");
		if (record.codexId) this.identities.set(record.codexId, record.id);
		const updated: AgentThreadRecord =
			result.state === "active"
				? { ...record, status: "running", turnId: result.turnId, requests: [] }
				: { ...record, status: "interrupted", requests: [] };
		await this.store.update(updated);
		this.pool.observe(record.id, updated.status);
		for (const listener of this.listeners.get(record.id) ?? []) listener();
		return result;
	}
	private async createThread(
		actor: Actor,
		projectId: string,
		title: string,
		managed: boolean,
		workspaceId?: string,
		reserveSlot = false,
	): Promise<AgentView> {
		this.authorize(actor);
		const input = createAgentSchema.safeParse({ title });
		if (!input.success) throw new AgentError("invalid-request");
		const id = this.generateId();
		if (reserveSlot && this.stopping) throw new AgentError("agent-capacity");
		if (reserveSlot) this.pool.claim(id);
		return this.serialize(id, async () => {
			const workspace = workspaceId
				? (await this.workspaces.resolve(actor, workspaceId)).workspace
				: await this.workspaces.create(actor, projectId, { name: input.data.title });
			if (workspace.projectId !== projectId) throw new AgentError("agent-conflict");
			const record: AgentThreadRecord = {
				id,
				projectId,
				workspaceId: workspace.id,
				title: input.data.title,
				createdAt: this.now().toISOString(),
				status: "idle",
				requests: [],
				managed,
			};
			await this.store.insert(record);
			return this.view(record);
		}).catch((cause: unknown) => {
			if (reserveSlot) this.pool.observe(id, "idle");
			throw cause;
		});
	}
	private authorize(actor: Actor): void {
		this.access.assertOwner(actor);
		if (this.closed) throw new AgentError("agent-unavailable");
	}
	private async require(id: string): Promise<AgentThreadRecord> {
		const record = await this.store.get(id);
		if (!record) throw new AgentError("agent-not-found");
		return record;
	}
	private view(record: AgentThreadRecord): AgentView {
		let runtime;
		try {
			if (record.codexId && this.identities.has(record.codexId)) runtime = this.client.read(record.codexId);
		} catch {}
		const { codexId: _codexId, managed: _managed, requests, contextWindow: savedContext, ...thread } = record;
		const contextWindow = runtime?.contextWindow ?? savedContext;
		return {
			thread,
			items: runtime?.items ?? [],
			requests: runtime?.requests ?? requests,
			truncated: runtime?.truncated ?? false,
			...(contextWindow && { contextWindow }),
		};
	}
	private async sync(record: AgentThreadRecord): Promise<AgentView> {
		if (record.codexId) {
			const runtime = this.client.read(record.codexId);
			// A persisted terminal outcome survives an unloaded runtime/history snapshot.
			if (["completed", "failed", "interrupted"].includes(record.status) && runtime.status === "uncertain")
				return this.view(record);
			const updated = {
				...record,
				status: runtime.status,
				turnId: runtime.turnId,
				requests: runtime.requests,
				contextWindow: runtime.contextWindow ?? record.contextWindow,
			};
			if (JSON.stringify(updated) !== JSON.stringify(record)) await this.store.update(updated);
			this.pool.observe(record.id, runtime.status);
			return this.view(updated);
		}
		return this.view(record);
	}
	private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
		const result = (this.queues.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
		this.queues.set(id, result);
		void result
			.finally(() => {
				if (this.queues.get(id) === result) this.queues.delete(id);
			})
			.catch(() => {});
		return result;
	}
}
