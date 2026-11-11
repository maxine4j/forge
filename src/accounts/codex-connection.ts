import { createLogger } from "@forge/backend-infrastructure/logger";
import type { ISleep } from "@forge/backend-infrastructure/sleep";
import { z } from "zod";

import type { IAccountProcess } from "./account-process.ts";
import type { AccountNotification, AccountProcessHandle, IAccountDiagnostics } from "./types.ts";

export class CodexConnectionError extends Error {
	constructor(options?: ErrorOptions) {
		super("Codex connection unavailable", options);
		this.name = "CodexConnectionError";
	}
}
export interface ICodexConnection {
	/** Idempotent initialization. Reconnects only when explicitly called; never replays a request. */
	initialize(): Promise<void>;
	/** Explicit user retry/cancel can reset an uncertain connection; never replays old work. */
	restart(): Promise<void>;
	/** Private allowlisted operations only. Throws CodexConnectionError. */
	request(method: string, params: unknown): Promise<unknown>;
	subscribe(listener: AccountNotification): () => void;
	close(): Promise<void>;
}
export interface ICodexAgentConnection extends ICodexConnection {
	/** A handler returns true only after accepting ownership of the request. */
	subscribeRequests(listener: (id: string | number, method: string, params: unknown) => boolean): () => void;
	/** Replies exactly once to a pending server request; reset invalidates outstanding IDs. */
	respond(id: string | number, result: unknown): void;
}
interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: AbortController;
}
const initializeSchema = z.object({
	userAgent: z.string().min(1).max(4096),
	codexHome: z.string().min(1).max(4096),
	platformFamily: z.string(),
	platformOs: z.string(),
});
const maximumFrameBytes = 16 * 1024 * 1024;
const methods = new Map<string, z.ZodType>([
	["model/list", z.strictObject({ limit: z.literal(100), cursor: z.string().optional() })],
	["skills/list", z.strictObject({ cwds: z.array(z.string().min(1)).length(1) })],
	[
		"fuzzyFileSearch",
		z.strictObject({
			query: z.string().max(500),
			roots: z.array(z.string().min(1)).length(1),
			cancellationToken: z.null(),
		}),
	],
	["account/read", z.strictObject({ refreshToken: z.boolean().optional() })],
	["account/rateLimits/read", z.null()],
	["account/login/start", z.strictObject({ type: z.literal("chatgptDeviceCode") })],
	["account/login/cancel", z.strictObject({ loginId: z.string().min(1).max(256) })],
	[
		"thread/start",
		z.strictObject({
			cwd: z.string().min(1),
			sandbox: z.literal("danger-full-access"),
			approvalPolicy: z.literal("on-request"),
			config: z.record(z.string(), z.unknown()),
		}),
	],
	[
		"thread/resume",
		z.strictObject({
			threadId: z.string().min(1),
			cwd: z.string().min(1),
			sandbox: z.literal("danger-full-access"),
			approvalPolicy: z.literal("on-request"),
			config: z.record(z.string(), z.unknown()),
			excludeTurns: z.literal(true),
		}),
	],
	["thread/read", z.strictObject({ threadId: z.string().min(1), includeTurns: z.boolean() })],
	[
		"thread/turns/list",
		z.strictObject({
			threadId: z.string().min(1),
			limit: z.literal(20),
			sortDirection: z.literal("desc"),
			itemsView: z.literal("notLoaded"),
		}),
	],
	[
		"thread/items/list",
		z.strictObject({
			threadId: z.string().min(1),
			limit: z.literal(20),
			sortDirection: z.literal("desc"),
			cursor: z.string().min(1).optional(),
		}),
	],
	[
		"turn/start",
		z.strictObject({
			threadId: z.string().min(1),
			cwd: z.string().min(1),
			model: z.string().min(1).max(256).optional(),
			approvalPolicy: z.enum(["on-request", "never"]).optional(),
			approvalsReviewer: z.enum(["user", "auto_review"]).optional(),
			input: z
				.array(
					z.union([
						z.strictObject({
							type: z.literal("text"),
							text: z.string().min(1).max(64000),
							text_elements: z.array(z.never()),
						}),
						z.strictObject({ type: z.literal("skill"), name: z.string().min(1), path: z.string().min(1) }),
					]),
				)
				.min(1)
				.max(101),
		}),
	],
	["turn/interrupt", z.strictObject({ threadId: z.string().min(1), turnId: z.string().min(1) })],
]);

export class CodexConnection implements ICodexAgentConnection {
	private handle: AccountProcessHandle | undefined;
	private initialization: Promise<void> | undefined;
	private stopping: Promise<void> = Promise.resolve();
	private closed = false;
	private buffer = "";
	private sequence = 0;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly expiredQuotaRequests = new Set<number>();
	private readonly listeners = new Set<AccountNotification>();
	private readonly requestListeners = new Set<(id: string | number, method: string, params: unknown) => boolean>();
	private readonly serverRequests = new Set<string | number>();
	constructor(
		private readonly processes: IAccountProcess,
		private readonly sleep: ISleep,
		private readonly deadlineMs: number = 15_000,
		private readonly log: IAccountDiagnostics = createLogger(CodexConnection.name),
	) {}
	async initialize(): Promise<void> {
		if (this.closed) throw new CodexConnectionError();
		this.initialization ??= this.connect();
		return this.initialization;
	}
	async request(method: string, params: unknown): Promise<unknown> {
		const schema = methods.get(method);
		if (!schema) throw new Error("Unsupported Codex operation");
		const parsed = schema.safeParse(params);
		if (!parsed.success) throw new Error("Invalid Codex operation input");
		if (!this.handle || !this.initialization) throw new CodexConnectionError();
		await this.initialization;
		return this.send(method, parsed.data);
	}
	subscribe(listener: AccountNotification): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	subscribeRequests(listener: (id: string | number, method: string, params: unknown) => boolean): () => void {
		this.requestListeners.add(listener);
		return () => this.requestListeners.delete(listener);
	}
	respond(id: string | number, result: unknown): void {
		if (!this.handle || !this.serverRequests.delete(id)) throw new CodexConnectionError();
		try {
			this.handle.write(JSON.stringify({ id, result }) + "\n");
		} catch (cause) {
			this.disconnect(cause);
			throw new CodexConnectionError({ cause });
		}
	}
	async restart(): Promise<void> {
		this.disconnect(new Error("Explicit account connection reset"), true);
		await this.stopping;
		await this.initialize();
	}
	async close(): Promise<void> {
		this.closed = true;
		this.disconnect(new Error("Forge shutting down"), true);
		await this.stopping;
	}
	private async connect(): Promise<void> {
		await this.stopping;
		if (this.closed) throw new CodexConnectionError();
		try {
			await this.processes.initialize();
			if (this.closed) throw new CodexConnectionError();
			const handle = this.processes.spawn({
				program: "codex",
				arguments: ["app-server", "-c", 'cli_auth_credentials_store="file"'],
				onOutput: (chunk) => {
					if (this.handle === handle) this.receive(chunk);
				},
			});
			this.handle = handle;
			this.buffer = "";
			void handle.done.then(
				() => {
					if (this.handle === handle) this.disconnect(new Error("Codex exited"));
				},
				(cause: unknown) => {
					if (this.handle === handle) this.disconnect(cause);
				},
			);
			initializeSchema.parse(
				await this.send("initialize", {
					clientInfo: { name: "forge", version: "0.1.0" },
					capabilities: { experimentalApi: false },
				}),
			);
			if (this.handle !== handle) throw new CodexConnectionError();
			handle.write(JSON.stringify({ method: "initialized" }) + "\n");
		} catch (cause) {
			this.disconnect(cause);
			throw new CodexConnectionError({ cause });
		}
	}
	private send(method: string, params: unknown): Promise<unknown> {
		const handle = this.handle;
		const quotaRead = method === "account/rateLimits/read";
		if (!handle || this.pending.size >= 32 || (quotaRead && this.expiredQuotaRequests.size >= 32))
			return Promise.reject(new CodexConnectionError());
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			const timer = new AbortController();
			this.pending.set(id, { resolve, reject, timer });
			void this.sleep(this.deadlineMs, timer.signal).then(
				() => {
					if (!this.pending.has(id)) return;
					const cause = new Error("Codex request deadline exceeded");
					if (quotaRead) {
						this.pending.delete(id);
						this.expiredQuotaRequests.add(id);
						reject(new CodexConnectionError({ cause }));
					} else this.disconnect(cause);
				},
				() => {},
			);
			try {
				handle.write(JSON.stringify({ id, method, params }) + "\n");
			} catch (cause) {
				this.disconnect(cause);
			}
		});
	}
	private receive(chunk: string): void {
		try {
			this.buffer += chunk;
			let newline: number;
			while ((newline = this.buffer.indexOf("\n")) >= 0) {
				if (Buffer.byteLength(this.buffer.slice(0, newline)) > maximumFrameBytes)
					throw new Error("Codex frame exceeded limit");
				const line = this.buffer.slice(0, newline);
				this.buffer = this.buffer.slice(newline + 1);
				if (line.trim()) this.message(JSON.parse(line));
			}
			if (Buffer.byteLength(this.buffer) > maximumFrameBytes) throw new Error("Codex frame exceeded limit");
		} catch (cause) {
			this.disconnect(cause);
		}
	}
	private message(value: unknown): void {
		const message = z
			.object({
				id: z.union([z.number().int().nonnegative(), z.string()]).optional(),
				method: z.string().max(256).optional(),
				params: z.unknown().optional(),
				result: z.unknown().optional(),
				error: z.object({ code: z.number(), message: z.string() }).optional(),
			})
			.parse(value);
		if (message.method) {
			if (message.id !== undefined) {
				if (this.serverRequests.has(message.id)) throw new Error("Duplicate Codex server request");
				this.serverRequests.add(message.id);
				if (
					[...this.requestListeners].some((listener) =>
						listener(message.id!, message.method!, message.params),
					)
				)
					return;
				this.serverRequests.delete(message.id);
				this.handle?.write(
					JSON.stringify({ id: message.id, error: { code: -32601, message: "Method not supported" } }) + "\n",
				);
			} else {
				if (message.method === "serverRequest/resolved") {
					const resolved = z
						.object({ threadId: z.string(), requestId: z.union([z.string(), z.number()]) })
						.parse(message.params);
					this.serverRequests.delete(resolved.requestId);
				}
				for (const listener of this.listeners) listener(message.method, message.params);
			}
			return;
		}
		if (typeof message.id !== "number") throw new Error("Invalid Codex response envelope");
		if (this.expiredQuotaRequests.delete(message.id)) return;
		const pending = this.pending.get(message.id);
		if (!pending) throw new Error("Unexpected Codex response");
		this.pending.delete(message.id);
		pending.timer.abort();
		if (message.error) pending.reject(new CodexConnectionError({ cause: new Error(message.error.message) }));
		else if ("result" in message) pending.resolve(message.result);
		else {
			pending.reject(new CodexConnectionError());
			throw new Error("Missing Codex result");
		}
	}
	private disconnect(cause: unknown, expected = false): void {
		const handle = this.handle;
		this.handle = undefined;
		this.initialization = undefined;
		this.buffer = "";
		for (const pending of this.pending.values()) {
			pending.timer.abort();
			pending.reject(new CodexConnectionError({ cause }));
		}
		this.pending.clear();
		this.expiredQuotaRequests.clear();
		this.serverRequests.clear();
		if (handle) {
			if (!expected) this.log.warn({ err: cause }, "Codex disconnected; pending work will not be replayed");
			if (!this.closed) for (const listener of this.listeners) listener("connection/lost", {});
			this.stopping = handle.stop().catch((err: unknown) => {
				this.log.error({ err }, "Codex process cleanup failed");
			});
		}
	}
}
