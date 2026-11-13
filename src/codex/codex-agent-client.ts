import { createLogger } from "@forge/backend-infrastructure/logger";
import {
	agentReplySchema,
	type AgentReply,
	type AgentRequest,
	type AgentItem,
	type AgentSettings,
	type AgentOptions,
} from "@forge/contracts/agents";
import type { InferenceProvider } from "@forge/contracts/settings";
import { z } from "zod";

import type { ICodexAgentConnection } from "../accounts/codex-connection.ts";
import { CodexRpcError } from "../accounts/codex-connection.ts";
import { AgentError } from "../agents/errors.ts";
import type { UsageScope } from "../cost/types.ts";
import type { ICodexUsageTracker } from "./codex-usage-client.ts";
import type { AgentRuntimeView, ExecutionReconciliation } from "./types.ts";
export interface ICodexAgentClient {
	reconcile(id?: string, path?: string, provider?: InferenceProvider): Promise<ExecutionReconciliation>;
	/** Uses persistent Codex history. Failures throw AgentError; requests are never replayed. */
	start(path: string, provider?: InferenceProvider): Promise<string>;
	resume(id: string, path: string, provider?: InferenceProvider): Promise<AgentRuntimeView>;
	/** Loads stored history without starting or subscribing to a runtime thread. Throws AgentError. */
	loadHistory(id: string): Promise<AgentRuntimeView>;
	read(id: string): AgentRuntimeView;
	send(id: string, path: string, text: string, settings?: AgentSettings, usage?: UsageScope): Promise<void>;
	options(path?: string, provider?: InferenceProvider): Promise<AgentOptions>;
	files(path: string, query: string): Promise<string[]>;
	interrupt(id: string, turnId: string): Promise<void>;
	steer(id: string, turnId: string, text: string, path?: string): Promise<void>;
	reply(id: string, input: AgentReply): void;
	subscribe(listener: (id: string) => void): () => void;
}
const ollamaProviderId = "forge_ollama";

export class CodexAgentClient implements ICodexAgentClient {
	private readonly log = createLogger(CodexAgentClient.name);
	private readonly views = new Map<string, AgentRuntimeView>();
	private readonly pending = new Map<string, { threadId: string; turnId: string; rpcId: string | number }>();
	private readonly listeners = new Set<(id: string) => void>();
	private readonly revisions = new Map<string, number>();
	private readonly resuming = new Set<string>();
	private readonly models = new Map<string, string>();
	private readonly ollamaThreads = new Set<string>();
	private readonly creations = new Map<object, number>();
	private readonly settled = new Set<string>();
	private readonly initialEpoch: number;
	constructor(
		private readonly connection: ICodexAgentConnection,
		private readonly realpath: (path: string) => Promise<string>,
		private readonly generateId: () => string,
		private readonly usageTracker?: ICodexUsageTracker,
	) {
		this.initialEpoch = connection.executionEpoch();
		connection.subscribe((method, params) => this.notification(method, params));
		connection.subscribeRequests((id, method, params) => this.serverRequest(id, method, params));
	}
	async start(path: string, provider?: InferenceProvider): Promise<string> {
		return this.guard(async () => {
			path = await this.realpath(path);
			await this.connection.initialize();
			const creation = {};
			this.creations.set(creation, this.connection.executionEpoch());
			const result = threadResponse.parse(
				await this.connection.request("thread/start", this.runtimeOptions(path, provider)),
			);
			if (result.thread.cwd !== path) throw new Error("Codex workspace identity mismatch");
			this.rememberRouting(result, provider);
			this.creations.delete(creation);
			this.views.set(result.thread.id, this.hydrate(result.thread));
			return result.thread.id;
		});
	}
	/** Execution metadata is independent of item/history pagination. Never replays input. */
	async reconcile(id?: string, path?: string, provider?: InferenceProvider): Promise<ExecutionReconciliation> {
		try {
			await this.connection.initialize(); // also awaits cleanup of a lost process
			if (!id)
				return {
					state:
						[...this.creations.values()].includes(this.connection.executionEpoch())
						|| (this.creations.size === 0 && this.connection.executionEpoch() === this.initialEpoch)
							? "unavailable"
							: "inactive",
				};
			if (!path) return { state: "unavailable" };
			path = await this.realpath(path);
			let thread: z.infer<typeof threadSchema>;
			try {
				const result = threadResponse.parse(
					await this.connection.request("thread/resume", {
						threadId: id,
						...this.runtimeOptions(path, provider),
						excludeTurns: true,
					}),
				);
				if (result.thread.id !== id || result.thread.cwd !== path)
					throw new Error("Codex workspace identity mismatch");
				this.rememberRouting(result, provider);
				thread = result.thread;
			} catch (error) {
				// Verified against 0.164.0: `thread not loaded` is NOT missing.
				if (
					error instanceof CodexRpcError
					&& error.code === -32600
					&& error.message === `no rollout found for thread id ${id}`
				) {
					this.settle(id);
					return { state: "missing" };
				}
				throw error;
			}
			if (thread.status.type === "idle") {
				this.settle(id);
				return { state: "inactive" };
			}
			if (thread.status.type !== "active") return { state: "unavailable" };
			const page = z.object({ data: z.array(turnSchema), nextCursor: z.string().nullable() }).parse(
				await this.connection.request("thread/turns/list", {
					threadId: id,
					limit: 20,
					sortDirection: "desc",
					itemsView: "notLoaded",
				}),
			);
			const turn = page.data.find((turn) => turn.status === "inProgress");
			if (!turn) return { state: "unavailable" };
			this.settled.delete(id);
			const view = this.views.get(id) ?? this.hydrate(thread);
			view.status = view.requests.length ? "waiting" : "running";
			view.turnId = turn.id;
			this.views.set(id, view);
			return { state: "active", turnId: turn.id };
		} catch (err) {
			this.log.warn({ err }, "Could not establish Codex execution state");
			return { state: "unavailable" };
		}
	}
	private settle(id: string): void {
		const view = this.views.get(id) ?? { status: "interrupted", items: [], requests: [], truncated: false };
		view.status = "interrupted";
		view.requests = [];
		delete view.plan;
		for (const [key, request] of this.pending) if (request.threadId === id) this.pending.delete(key);
		this.views.set(id, view);
		this.settled.add(id);
	}
	async resume(id: string, path: string, provider?: InferenceProvider): Promise<AgentRuntimeView> {
		this.resuming.add(id);
		return this.guard(async () => {
			const revision = this.revisions.get(id);
			const before = new Map(this.views.get(id)?.items.map((item) => [item.id, item.text]));
			if (!this.views.has(id))
				this.views.set(id, { status: "uncertain", items: [], requests: [], truncated: false });
			path = await this.realpath(path);
			await this.connection.initialize();
			const result = threadResponse.parse(
				await this.connection.request("thread/resume", {
					threadId: id,
					...this.runtimeOptions(path, provider),
					excludeTurns: true,
				}),
			);
			if (result.thread.id !== id || result.thread.cwd !== path)
				throw new Error("Codex workspace identity mismatch");
			this.rememberRouting(result, provider);
			const view = await this.history(result.thread);
			const live = this.views.get(id)!;
			if (this.settled.has(id)) {
				view.status = live.status;
				view.turnId = live.turnId;
				if (live.status !== "completed") delete view.plan;
			}
			view.requests = live.requests;
			view.contextWindow = live.contextWindow;
			if (this.revisions.get(id) !== revision) {
				view.status = live.status;
				if (view.turnId !== live.turnId) delete view.plan;
				view.turnId = live.turnId;
				if (live.plan !== undefined) view.plan = live.plan;
				view.truncated ||= live.truncated;
				for (const item of live.items) if (before.get(item.id) !== item.text) this.put(view, item);
			}
			if (
				!this.settled.has(id)
				&& (["systemError", "notLoaded"].includes(result.thread.status.type) || view.status === "uncertain")
			) {
				view.status = "uncertain";
				view.requests = [];
				for (const [key, request] of this.pending) if (request.threadId === id) this.pending.delete(key);
			} else if (view.requests.length) view.status = "waiting";
			this.views.set(id, view);
			return this.read(id);
		}).finally(() => this.resuming.delete(id));
	}
	async loadHistory(id: string): Promise<AgentRuntimeView> {
		return this.guard(async () => {
			await this.connection.initialize();
			const { thread } = threadResponse.parse(
				await this.connection.request("thread/read", { threadId: id, includeTurns: false }),
			);
			if (thread.id !== id) throw new Error("Codex thread identity mismatch");
			const view = await this.history(thread);
			if (this.settled.has(id)) {
				const settled = this.views.get(id)!;
				view.status = settled.status;
				view.turnId = settled.turnId;
				if (settled.status !== "completed") delete view.plan;
			}
			view.contextWindow = this.views.get(id)?.contextWindow;
			this.views.set(id, view);
			return this.read(id);
		});
	}
	read(id: string): AgentRuntimeView {
		const view = this.views.get(id);
		if (!view) throw new AgentError("agent-unavailable");
		return structuredClone(view);
	}
	async options(path?: string, provider?: InferenceProvider): Promise<AgentOptions> {
		return this.guard(async () => {
			if (provider?.kind === "ollama") {
				if (path) await this.connection.initialize();
				const skills = path ? await this.skills(path) : [];
				return {
					models: [{ id: provider.model, name: provider.model, isDefault: true }],
					skills: skills.map(({ name, description }) => ({ name, description })),
					defaultModel: provider.model,
					supportsAutoReview: false,
				};
			}
			await this.connection.initialize();
			const models: AgentOptions["models"] = [];
			let cursor: string | undefined;
			let pages = 0;
			do {
				const page = z
					.object({
						data: z.array(
							z.object({
								model: z.string().min(1).max(256),
								displayName: z.string().max(256),
								isDefault: z.boolean(),
								supportedReasoningEfforts: z
									.array(z.object({ reasoningEffort: z.string().min(1), description: z.string() }))
									.optional(),
								defaultReasoningEffort: z.string().min(1).optional(),
							}),
						),
						nextCursor: z.string().nullable(),
					})
					.parse(await this.connection.request("model/list", { limit: 100, ...(cursor ? { cursor } : {}) }));
				models.push(
					...page.data.map((model) => ({
						id: model.model,
						name: model.displayName,
						isDefault: model.isDefault,
						supportedReasoningEfforts: model.supportedReasoningEfforts,
						defaultReasoningEffort: model.defaultReasoningEffort,
					})),
				);
				if (
					models.length > 500
					|| (++pages >= 5 && page.nextCursor)
					|| (page.nextCursor && page.nextCursor === cursor)
				)
					throw new Error("Invalid model pagination");
				cursor = page.nextCursor ?? undefined;
			} while (cursor);
			const skills = path ? await this.skills(path) : [];
			return { models, skills: skills.map(({ name, description }) => ({ name, description })) };
		});
	}
	async files(path: string, query: string): Promise<string[]> {
		return this.guard(async () => {
			path = await this.realpath(path);
			await this.connection.initialize();
			const result = z
				.object({ files: z.array(z.object({ root: z.string(), path: z.string().min(1).max(4096) })) })
				.parse(
					await this.connection.request("fuzzyFileSearch", { query, roots: [path], cancellationToken: null }),
				);
			return [
				...new Set(
					result.files
						.filter(
							(file) =>
								file.root === path
								&& !file.path.startsWith("/")
								&& !file.path.includes("\\")
								&& !file.path.split("/").some((part) => part === ".." || part === "."),
						)
						.map((file) => file.path),
				),
			].slice(0, 100);
		});
	}
	async send(id: string, path: string, text: string, settings?: AgentSettings, usage?: UsageScope): Promise<void> {
		await this.guard(async () => {
			const view = this.views.get(id);
			if (!view || ["running", "waiting", "uncertain"].includes(view.status))
				throw new AgentError("agent-conflict");
			const ollama = this.ollamaThreads.has(id);
			if (
				ollama
				&& (settings?.permissions === "approve-for-me"
					|| settings?.reasoningEffort
					|| (settings?.model && settings.model !== this.models.get(id)))
			)
				throw new AgentError("unsupported-settings");
			const selectedSkills = /(?:^|\s)\$[\w-]+/.test(text)
				? (await this.skills(path)).filter((skill) => text.split(/\s+/).includes(`$${skill.name}`))
				: [];
			const model = settings?.model ?? this.models.get(id);
			if (usage?.phase === "planning" && !model) throw new AgentError("agent-unavailable");
			view.status = "running";
			this.settled.delete(id);
			delete view.turnId;
			delete view.plan;
			try {
				if (usage && !ollama) await this.usageTracker?.track(id, usage, model);
				const result = z.object({ turn: turnSchema }).parse(
					await this.connection.request("turn/start", {
						threadId: id,
						cwd: path,
						...(usage?.phase === "planning"
							? {
									collaborationMode: {
										mode: "plan",
										settings: {
											model,
											...(!ollama ? { reasoning_effort: settings?.reasoningEffort ?? null } : {}),
											developer_instructions: null,
										},
									},
								}
							: {}),
						...(settings
							? {
									...(model ? { model } : {}),
									...(!ollama ? { effort: settings.reasoningEffort ?? null } : {}),
									approvalPolicy: settings.permissions === "full-access" ? "never" : "on-request",
									approvalsReviewer:
										settings.permissions === "approve-for-me" ? "auto_review" : "user",
								}
							: {}),
						input: [
							{ type: "text", text, text_elements: [] },
							...selectedSkills.map(({ name, path }) => ({ type: "skill", name, path })),
						],
					}),
				);
				// Completion notifications can precede the RPC response. Do not resurrect a finished turn.
				if (!view.turnId) {
					view.turnId = result.turn.id;
					view.status = this.status(result.turn.status);
				}
			} catch (cause) {
				view.status = "uncertain";
				this.emit(id);
				throw cause;
			}
		});
	}
	async steer(id: string, turnId: string, text: string, path?: string): Promise<void> {
		await this.guard(async () => {
			const view = this.views.get(id);
			if (!view || view.status !== "running" || view.turnId !== turnId || view.requests.length)
				throw new AgentError("agent-conflict");
			const skills =
				path && /(?:^|\s)\$[\w-]+/.test(text)
					? (await this.skills(path)).filter((skill) => text.split(/\s+/).includes(`$${skill.name}`))
					: [];
			const result = z.object({ turnId: z.string() }).parse(
				await this.connection.request("turn/steer", {
					threadId: id,
					expectedTurnId: turnId,
					input: [
						{ type: "text", text, text_elements: [] },
						...skills.map(({ name, path }) => ({ type: "skill", name, path })),
					],
				}),
			);
			if (result.turnId !== turnId) throw new AgentError("agent-conflict");
		});
	}
	async interrupt(id: string, turnId: string): Promise<void> {
		await this.guard(async () => {
			await this.connection.request("turn/interrupt", { threadId: id, turnId });
		});
	}
	reply(id: string, input: AgentReply): void {
		const parsed = agentReplySchema.safeParse(input);
		if (!parsed.success) throw new AgentError("invalid-request");
		const pending = this.pending.get(input.requestId);
		const view = this.views.get(id);
		const request = view?.requests.find((value) => value.id === input.requestId);
		if (!pending || pending.threadId !== id || !view || !request || pending.turnId !== view.turnId)
			throw new AgentError("agent-conflict");
		let result: unknown;
		if (request.kind === "input") {
			if (
				input.decision
				|| !input.answers
				|| Object.keys(input.answers).length !== request.questions.length
				|| request.questions.some((question) => !input.answers?.[question.id])
			)
				throw new AgentError("invalid-request");
			result = {
				answers: Object.fromEntries(
					request.questions.map((question) => [question.id, { answers: [input.answers![question.id]] }]),
				),
			};
		} else {
			if (!input.decision || input.answers) throw new AgentError("invalid-request");
			result = { decision: input.decision };
		}
		try {
			this.connection.respond(pending.rpcId, result);
		} catch (cause) {
			throw new AgentError("agent-unavailable", { cause });
		}
		this.pending.delete(input.requestId);
		view.requests = view.requests.filter((value) => value.id !== input.requestId);
		view.status = view.requests.length ? "waiting" : "running";
		this.emit(id);
	}
	subscribe(listener: (id: string) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private async skills(path: string): Promise<{ name: string; description: string; path: string }[]> {
		path = await this.realpath(path);
		const result = z
			.object({
				data: z.array(
					z.object({
						cwd: z.string(),
						skills: z.array(
							z.object({
								name: z.string().min(1).max(256),
								description: z.string().max(4000),
								path: z.string().min(1),
								enabled: z.boolean(),
							}),
						),
						errors: z.array(z.unknown()),
					}),
				),
			})
			.parse(await this.connection.request("skills/list", { cwds: [path] }));
		const entry = result.data.find((entry) => entry.cwd === path);
		if (!entry || entry.errors.length || entry.skills.length > 500) throw new Error("Skills unavailable");
		return entry.skills.filter((skill) => skill.enabled);
	}
	private runtimeOptions(path: string, provider?: InferenceProvider) {
		return {
			cwd: path,
			sandbox: "danger-full-access",
			approvalPolicy: "on-request",
			...(provider?.kind === "ollama" ? { model: provider.model, modelProvider: ollamaProviderId } : {}),
			config: {
				features: { multi_agent: false },
				...(provider?.kind === "ollama"
					? {
							web_search: "disabled",
							model_providers: {
								[ollamaProviderId]: {
									name: "Ollama",
									base_url: provider.endpoint,
									wire_api: "responses",
									requires_openai_auth: false,
								},
							},
						}
					: {}),
			},
		};
	}
	private rememberRouting(result: z.infer<typeof threadResponse>, provider?: InferenceProvider): void {
		const { id, modelProvider } = result.thread;
		if (provider?.kind === "ollama") {
			if (
				modelProvider !== ollamaProviderId
				|| result.modelProvider !== ollamaProviderId
				|| result.model !== provider.model
			)
				throw new Error("Codex inference provider mismatch");
			this.ollamaThreads.add(id);
		}
		if (result.model) this.models.set(id, result.model);
		else this.models.delete(id);
	}
	private hydrate(thread: z.infer<typeof threadSchema>): AgentRuntimeView {
		const last = thread.turns.at(-1);
		const view: AgentRuntimeView = {
			status: ["systemError", "notLoaded"].includes(thread.status.type)
				? "uncertain"
				: thread.status.type === "active"
					? "running"
					: last
						? this.status(last.status)
						: "idle",
			...(last ? { turnId: last.id } : {}),
			items: [],
			requests: [],
			truncated: false,
		};
		for (const turn of thread.turns) {
			for (const item of turn.items) this.item(view, item, turn.id === last?.id && turn.status === "completed");
			this.finishTools(view, this.status(turn.status));
		}
		return view;
	}
	private async history(thread: z.infer<typeof threadSchema>): Promise<AgentRuntimeView> {
		const page = z.object({ data: z.array(turnSchema).max(20), nextCursor: z.string().nullable() }).parse(
			await this.connection.request("thread/turns/list", {
				threadId: thread.id,
				limit: 20,
				sortDirection: "desc",
				itemsView: "notLoaded",
			}),
		);
		// Read newest items first so a noisy earlier command cannot evict the final result.
		const history = page.data.reverse();
		const turns = new Map(history.map((turn) => [turn.id, turn.status]));
		const view = this.hydrate({ ...thread, turns: history.map((turn) => ({ ...turn, items: [] })) });
		view.truncated ||= page.nextCursor !== null;
		if (!turns.size) return view;
		const newest: AgentItem[] = [];
		const cursors = new Set<string>();
		const ids = new Set<string>();
		let cursor: string | undefined;
		let characters = 0;
		for (let pages = 0; pages < 25; pages++) {
			const page = z
				.object({
					data: z.array(z.object({ turnId: z.string(), item: z.unknown() })).max(20),
					nextCursor: z.string().nullable(),
				})
				.parse(
					await this.connection.request("thread/items/list", {
						threadId: thread.id,
						limit: 20,
						sortDirection: "desc",
						...(cursor ? { cursor } : {}),
					}),
				);
			for (const entry of page.data) {
				const status = turns.get(entry.turnId);
				if (!status) {
					view.truncated = true;
					view.items = newest.reverse();
					return view;
				}
				const itemView: AgentRuntimeView = { status: view.status, items: [], requests: [], truncated: false };
				this.item(itemView, entry.item, entry.turnId === view.turnId && status === "completed");
				if (itemView.plan !== undefined) view.plan ??= itemView.plan;
				this.finishTools(itemView, this.status(status));
				view.truncated ||= itemView.truncated;
				const item = itemView.items[0]!;
				if (ids.has(item.id)) throw new Error("Duplicate Codex history item");
				if (newest.length >= 500 || characters + item.text.length > 240000) {
					view.truncated = true;
					view.items = newest.reverse();
					return view;
				}
				ids.add(item.id);
				newest.push(item);
				characters += item.text.length;
			}
			if (page.nextCursor === null) {
				view.items = newest.reverse();
				return view;
			}
			if (cursors.has(page.nextCursor)) throw new Error("Invalid Codex item pagination");
			cursors.add(page.nextCursor);
			cursor = page.nextCursor;
		}
		view.truncated = true;
		view.items = newest.reverse();
		return view;
	}
	private finishTools(view: AgentRuntimeView, status: AgentRuntimeView["status"]): void {
		if (status !== "completed" && status !== "failed" && status !== "interrupted") return;
		for (const item of view.items) if (item.status === "running") item.status = status;
	}
	private status(status: string): AgentRuntimeView["status"] {
		return status === "inProgress"
			? "running"
			: status === "completed"
				? "completed"
				: status === "interrupted"
					? "interrupted"
					: "failed";
	}
	private item(view: AgentRuntimeView, raw: unknown, capturePlan = false): void {
		const item = z
			.object({
				id: z.string().min(1).max(256),
				type: z.string(),
				text: z.string().optional(),
				command: z.string().optional(),
				aggregatedOutput: z.string().nullish(),
				status: z.string().optional(),
				content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
			})
			.parse(raw);
		if (capturePlan && item.type === "plan" && item.text?.trim() && item.text.length <= 32000)
			view.plan = item.text.trim();
		const role: AgentItem["role"] =
			item.type === "userMessage"
				? "user"
				: ["agentMessage", "plan"].includes(item.type)
					? "assistant"
					: "activity";
		const text =
			item.type === "userMessage"
				? (item.content ?? []).map((part) => part.text ?? `[${part.type}]`).join("\n")
				: (item.text
					?? (item.type === "commandExecution"
						? `${item.command ?? "Command"}\n${item.aggregatedOutput ?? item.status ?? ""}`
						: `${item.type}${item.status ? `: ${item.status}` : ""}`));
		this.put(view, {
			id: item.id,
			role,
			...(item.type === "plan" ? { kind: "plan" as const } : {}),
			text,
			...(role === "activity"
				? {
						title: (item.command ?? item.type.replace(/([a-z])([A-Z])/g, "$1 $2")).slice(0, 256),
						...(item.status
							? {
									status:
										item.status === "inProgress"
											? ("running" as const)
											: item.status === "failed" || item.status === "declined"
												? ("failed" as const)
												: item.status === "interrupted"
													? ("interrupted" as const)
													: ("completed" as const),
								}
							: {}),
					}
				: {}),
		});
	}
	private put(view: AgentRuntimeView, item: AgentItem): void {
		if (item.text.length > 32000) {
			item.text = item.text.slice(0, 32000);
			view.truncated = true;
		}
		const index = view.items.findIndex((value) => value.id === item.id);
		if (index >= 0) view.items[index] = item;
		else view.items.push(item);
		// Bound the full browser snapshot as well as individual output.
		while (view.items.length > 500 || view.items.reduce((size, value) => size + value.text.length, 0) > 240000) {
			view.items.shift();
			view.truncated = true;
		}
	}
	private notification(method: string, params: unknown): void {
		if (method === "connection/lost") {
			this.pending.clear();
			for (const [id, view] of this.views) {
				if (this.settled.has(id)) continue;
				if (!this.resuming.has(id) && ["idle", "completed", "failed", "interrupted"].includes(view.status))
					continue;
				view.status = "uncertain";
				view.requests = [];
				this.emit(id);
			}
			return;
		}
		const envelope = z.object({ threadId: z.string() }).safeParse(params);
		if (!envelope.success) return;
		const id = envelope.data.threadId;
		if (this.settled.has(id)) return;
		const view = this.views.get(id);
		if (!view) return;
		try {
			if (method === "thread/tokenUsage/updated") {
				const sample = contextUpdate.safeParse(params);
				if (!sample.success || (view.turnId && view.turnId !== sample.data.turnId)) return;
				const { last, modelContextWindow } = sample.data.tokenUsage;
				if (view.contextWindow?.used === last.totalTokens && view.contextWindow.max === modelContextWindow)
					return;
				view.contextWindow = { used: last.totalTokens, max: modelContextWindow };
			} else if (method === "thread/status/changed") {
				const { status } = z.object({ status: threadStatusSchema }).parse(params);
				if (!["systemError", "notLoaded"].includes(status.type)) return;
				view.status = "uncertain";
				view.requests = [];
				for (const [key, request] of this.pending) if (request.threadId === id) this.pending.delete(key);
			} else if (method === "serverRequest/resolved") {
				const resolved = z.object({ requestId: z.union([z.string(), z.number()]) }).parse(params);
				for (const [key, request] of this.pending) {
					if (request.threadId !== id || request.rpcId !== resolved.requestId) continue;
					this.pending.delete(key);
					view.requests = view.requests.filter((value) => value.id !== key);
				}
				if (view.status === "waiting" && !view.requests.length) view.status = "running";
			} else if (method === "error") {
				const error = z.object({ turnId: z.string(), willRetry: z.boolean() }).parse(params);
				if (view.turnId && error.turnId !== view.turnId) return;
				if (!error.willRetry) {
					this.settled.add(id);
					view.turnId = error.turnId;
					view.status = "failed";
					this.finishTools(view, "failed");
					view.requests = [];
					for (const [key, request] of this.pending) if (request.threadId === id) this.pending.delete(key);
				}
			} else if (method === "turn/started" || method === "turn/completed") {
				const { turn } = z.object({ turn: turnSchema }).parse(params);
				if (view.turnId && view.turnId !== turn.id) {
					if (method === "turn/completed") return;
					delete view.plan;
				}
				view.turnId = turn.id;
				view.status = this.status(turn.status);
				for (const item of turn.items) this.item(view, item, turn.status === "completed");
				if (method === "turn/completed") {
					this.settled.add(id);
					this.finishTools(view, view.status);
					view.requests = [];
					for (const [key, request] of this.pending) if (request.threadId === id) this.pending.delete(key);
				}
			} else if (method === "item/started" || method === "item/completed") {
				const { item, turnId } = z.object({ item: z.unknown(), turnId: z.string().optional() }).parse(params);
				this.item(view, item, method === "item/completed" && !!turnId && view.turnId === turnId);
			} else if (
				["item/agentMessage/delta", "item/plan/delta", "item/commandExecution/outputDelta"].includes(method)
			) {
				const delta = z.object({ itemId: z.string().min(1).max(256), delta: z.string() }).parse(params);
				const existing = view.items.find((item) => item.id === delta.itemId);
				this.put(view, {
					...existing,
					id: delta.itemId,
					role: method === "item/commandExecution/outputDelta" ? "activity" : "assistant",
					...(method === "item/plan/delta" ? { kind: "plan" as const } : {}),
					text: (existing?.text ?? "") + delta.delta,
				});
			} else return;
			this.emit(id);
		} catch (err) {
			this.log.warn({ err }, "Invalid Codex activity");
			view.status = "uncertain";
			this.emit(id);
		}
	}
	private serverRequest(rpcId: string | number, method: string, params: unknown): boolean {
		if (
			![
				"item/commandExecution/requestApproval",
				"item/fileChange/requestApproval",
				"item/tool/requestUserInput",
			].includes(method)
		)
			return false;
		try {
			const raw = z
				.object({
					threadId: z.string(),
					turnId: z.string(),
					reason: z.string().nullish(),
					command: z.string().nullish(),
					questions: z
						.array(
							z.object({
								id: z.string().min(1).max(256),
								question: z.string().max(4000),
								isSecret: z.boolean(),
								options: z
									.array(z.object({ label: z.string().max(1000) }))
									.max(20)
									.nullish(),
							}),
						)
						.max(10)
						.optional(),
				})
				.parse(params);
			const view = this.views.get(raw.threadId);
			if (
				!view
				|| this.settled.has(raw.threadId)
				|| view.requests.length >= 32
				|| (view.turnId && view.turnId !== raw.turnId)
			)
				return false;
			const id = this.generateId();
			const request: AgentRequest = {
				id,
				kind: method.includes("requestUserInput")
					? "input"
					: method.includes("fileChange")
						? "file"
						: "command",
				description: [raw.reason, raw.command].filter(Boolean).join("\n").slice(0, 8000),
				questions: (raw.questions ?? []).map((question) => ({
					id: question.id,
					question: question.question,
					secret: question.isSecret,
					options: question.options?.map((option) => option.label) ?? [],
				})),
			};
			if (request.kind === "input" && !request.questions.length) return false;
			this.pending.set(id, { threadId: raw.threadId, turnId: raw.turnId, rpcId });
			view.turnId = raw.turnId;
			view.requests.push(request);
			view.status = "waiting";
			this.emit(raw.threadId);
			return true;
		} catch (err) {
			this.log.warn({ err }, "Unsupported Codex request");
			return false;
		}
	}
	private emit(id: string): void {
		this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
		for (const listener of this.listeners) listener(id);
	}
	private async guard<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			if (cause instanceof AgentError) throw cause;
			this.log.warn({ err: cause }, "Codex execution unavailable");
			throw new AgentError("agent-unavailable", { cause });
		}
	}
}

const turnSchema = z.object({
	id: z.string().min(1).max(256),
	status: z.enum(["inProgress", "completed", "interrupted", "failed"]),
	items: z.array(z.unknown()),
});
const contextUpdate = z.object({
	turnId: z.string(),
	tokenUsage: z.object({
		last: z.object({ totalTokens: z.int().nonnegative() }),
		modelContextWindow: z.int().positive(),
	}),
});
const threadStatusSchema = z.object({ type: z.enum(["notLoaded", "idle", "active", "systemError"]) });
const threadSchema = z.object({
	id: z.string().min(1).max(256),
	cwd: z.string(),
	modelProvider: z.string().optional(),
	historyMode: z.literal("paginated"),
	status: threadStatusSchema,
	turns: z.array(turnSchema),
});
const threadResponse = z.object({
	thread: threadSchema,
	model: z.string().optional(),
	modelProvider: z.string().optional(),
});
