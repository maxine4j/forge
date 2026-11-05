import type { ISleep } from "@forge/backend-infrastructure/sleep";
import {
	terminalClientMessageSchema,
	terminalDimensionsSchema,
	terminalSessionSchema,
	type TerminalClientMessage,
	type TerminalDimensions,
	type TerminalSession,
} from "@forge/contracts/terminal";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { IWorkspaceService } from "../workspaces/workspace-service.ts";
import { TerminalError } from "./errors.ts";
import type { ITerminalProcess } from "./terminal-process.ts";
import type { ITerminalStore } from "./terminal-store.ts";
import type { TerminalAttachment, TerminalListener, TerminalProcessHandle } from "./types.ts";

interface LiveTerminal {
	session: TerminalSession;
	process?: TerminalProcessHandle;
	listeners: Set<TerminalListener>;
	frames: { type: "output"; sequence: number; data: string }[];
	sequence: number;
	bytes: number;
	totalBytes: number;
	inputBytes: number;
	deadline: AbortController;
	closing: boolean;
}

export interface ITerminalService {
	/** Owner-only serialized operations. Create alone starts a shell; failures throw TerminalError or collaborator authorization/workspace errors. */
	create(actor: Actor, workspaceId: string, dimensions: TerminalDimensions): Promise<TerminalSession>;
	status(actor: Actor, workspaceId: string): Promise<TerminalSession | undefined>;
	get(actor: Actor, id: string): Promise<TerminalSession>;
	close(actor: Actor, id: string): Promise<TerminalSession>;
	/** Replays bounded output before live updates; detach never stops or replaces the shell. */
	attach(actor: Actor, id: string, after: number, listener: TerminalListener): Promise<TerminalAttachment>;
	input(actor: Actor, id: string, message: TerminalClientMessage): Promise<void>;
	recover(): Promise<void>;
	shutdown(): Promise<void>;
}
export class TerminalService implements ITerminalService {
	private readonly live = new Map<string, LiveTerminal>();
	private tail: Promise<unknown> = Promise.resolve();
	private queued = 0;
	private stopping = false;
	constructor(
		private readonly store: ITerminalStore,
		private readonly processes: ITerminalProcess,
		private readonly workspaces: IWorkspaceService,
		private readonly access: IAccessService,
		private readonly generateId: () => string,
		private readonly now: () => Date,
		private readonly sleep: ISleep,
	) {}
	async create(actor: Actor, workspaceId: string, dimensions: TerminalDimensions): Promise<TerminalSession> {
		this.access.assertOwner(actor);
		const parsed = terminalDimensionsSchema.safeParse(dimensions);
		if (!parsed.success) throw new TerminalError("invalid-request");
		return this.serialize(async () => {
			if (this.stopping) throw new TerminalError("terminal-unavailable");
			const location = await this.workspaces.resolve(actor, workspaceId);
			if ([...this.live.values()].some((item) => item.session.workspaceId === workspaceId))
				throw new TerminalError("terminal-conflict");
			if (this.live.size >= 8) throw new TerminalError("terminal-capacity");
			const session = terminalSessionSchema.parse({
				id: this.generateId(),
				workspaceId,
				status: "starting",
				createdAt: this.now().toISOString(),
				...parsed.data,
			});
			await this.store.insert(session);
			const live: LiveTerminal = {
				session,
				listeners: new Set(),
				frames: [],
				sequence: 0,
				bytes: 0,
				totalBytes: 0,
				inputBytes: 0,
				deadline: new AbortController(),
				closing: false,
			};
			this.live.set(session.id, live);
			try {
				live.process = await this.processes.spawn({
					...parsed.data,
					path: location.path,
					onOutput: (data) => this.output(live, data),
				});
				live.session = { ...session, status: "running" };
				await this.store.update(live.session);
				void live.process.done
					.then(
						(code) => this.serialize(() => this.finish(live, "exited", code)),
						() => this.serialize(() => this.finish(live, "lost")),
					)
					.catch(() => {});
				void this.sleep(8 * 60 * 60 * 1000, live.deadline.signal)
					.then(
						() => this.serialize(() => this.stop(live)),
						() => {},
					)
					.catch(() => {});
				return { ...live.session };
			} catch (cause) {
				await live.process?.stop().catch(() => {});
				await this.finish(live, "lost");
				throw new TerminalError("terminal-unavailable", { cause });
			}
		});
	}
	async status(actor: Actor, workspaceId: string): Promise<TerminalSession | undefined> {
		this.access.assertOwner(actor);
		await this.workspaces.get(actor, workspaceId);
		return this.serialize(() => this.store.latest(workspaceId));
	}
	async get(actor: Actor, id: string): Promise<TerminalSession> {
		this.access.assertOwner(actor);
		return this.serialize(() => this.require(id));
	}
	async close(actor: Actor, id: string): Promise<TerminalSession> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const session = await this.require(id);
			const live = this.live.get(id);
			if (live) await this.stop(live);
			return live ? { ...live.session } : session;
		});
	}
	async attach(actor: Actor, id: string, after: number, listener: TerminalListener): Promise<TerminalAttachment> {
		this.access.assertOwner(actor);
		if (!Number.isSafeInteger(after) || after < 0) throw new TerminalError("invalid-request");
		return this.serialize(async () => {
			const session = await this.require(id);
			await this.workspaces.resolve(actor, session.workspaceId);
			const live = this.live.get(id);
			if (live) {
				if (live.listeners.size >= 4) throw new TerminalError("terminal-capacity");
				if (after > live.sequence) throw new TerminalError("invalid-request");
				const through = (live.frames.at(0)?.sequence ?? live.sequence + 1) - 1;
				if (after < through) listener({ type: "gap", through });
				for (const frame of live.frames) if (frame.sequence > after) listener(frame);
				live.listeners.add(listener);
			} else listener({ type: "gap", through: after });
			listener({ type: "status", session });
			return {
				session,
				detach: () => {
					live?.listeners.delete(listener);
				},
			};
		});
	}
	async input(actor: Actor, id: string, message: TerminalClientMessage): Promise<void> {
		this.access.assertOwner(actor);
		const parsed = terminalClientMessageSchema.safeParse(message);
		if (!parsed.success || (parsed.data.type === "input" && Buffer.byteLength(parsed.data.data) > 16384))
			throw new TerminalError("invalid-request");
		await this.serialize(async () => {
			const session = await this.require(id);
			await this.workspaces.resolve(actor, session.workspaceId);
			const live = this.live.get(id);
			if (!live?.process || live.closing) throw new TerminalError("terminal-unavailable");
			if (parsed.data.type === "input" && live.inputBytes + Buffer.byteLength(parsed.data.data) > 1048576)
				throw new TerminalError("terminal-capacity");
			try {
				if (parsed.data.type === "input") {
					live.inputBytes += Buffer.byteLength(parsed.data.data);
					live.process.write(parsed.data.data);
				} else {
					live.process.resize(parsed.data.cols, parsed.data.rows);
					live.session = { ...live.session, cols: parsed.data.cols, rows: parsed.data.rows };
					await this.store.update(live.session);
					this.publish(live, { type: "status", session: live.session });
				}
			} catch (cause) {
				throw new TerminalError("terminal-unavailable", { cause });
			}
		});
	}
	async recover(): Promise<void> {
		await this.store.loseActive(this.now().toISOString());
	}
	async shutdown(): Promise<void> {
		this.stopping = true;
		await this.serialize(async () => {
			const results = await Promise.allSettled([...this.live.values()].map((live) => this.stop(live)));
			if (results.some((r) => r.status === "rejected")) throw new TerminalError("terminal-unavailable");
		}, true);
	}
	private async require(id: string): Promise<TerminalSession> {
		if (!terminalSessionSchema.shape.id.safeParse(id).success) throw new TerminalError("invalid-request");
		const session = await this.store.get(id);
		if (!session) throw new TerminalError("terminal-not-found");
		return session;
	}
	private async stop(live: LiveTerminal): Promise<void> {
		if (!this.live.has(live.session.id)) return;
		live.closing = true;
		await live.process?.stop();
		await this.finish(live, "closed");
	}
	private async finish(live: LiveTerminal, status: "closed" | "exited" | "lost", exitCode?: number): Promise<void> {
		if (!this.live.has(live.session.id)) return;
		live.deadline.abort();
		live.session = {
			...live.session,
			status,
			endedAt: this.now().toISOString(),
			...(exitCode === undefined ? {} : { exitCode }),
		};
		await this.store.update(live.session);
		this.live.delete(live.session.id);
		this.publish(live, { type: "status", session: live.session });
		live.listeners.clear();
	}
	private output(live: LiveTerminal, data: string): void {
		if (live.closing || !this.live.has(live.session.id)) return;
		live.totalBytes += Buffer.byteLength(data);
		if (live.totalBytes > 16 * 1024 * 1024) {
			live.closing = true;
			void this.serialize(() => this.stop(live), true).catch(() => {});
			return;
		}
		// Split at Unicode code points; JSON frames remain independently decodable.
		let chunk = "";
		let bytes = 0;
		for (const character of data) {
			const size = Buffer.byteLength(character);
			if (bytes + size > 16384) {
				this.frame(live, chunk);
				chunk = "";
				bytes = 0;
			}
			chunk += character;
			bytes += size;
		}
		if (chunk) this.frame(live, chunk);
	}
	private frame(live: LiveTerminal, data: string): void {
		const frame = { type: "output" as const, sequence: ++live.sequence, data };
		live.frames.push(frame);
		live.bytes += Buffer.byteLength(data);
		while (live.bytes > 262144 || live.frames.length > 1024)
			live.bytes -= Buffer.byteLength(live.frames.shift()!.data);
		this.publish(live, frame);
	}
	private publish(live: LiveTerminal, message: Parameters<TerminalListener>[0]): void {
		for (const listener of live.listeners) {
			try {
				listener(message);
			} catch {
				live.listeners.delete(listener);
			}
		}
	}
	private serialize<T>(operation: () => Promise<T>, cleanup = false): Promise<T> {
		if (!cleanup && this.queued >= 64) return Promise.reject(new TerminalError("terminal-capacity"));
		this.queued++;
		const next = this.tail.then(operation);
		this.tail = next
			.catch(() => {})
			.finally(() => {
				this.queued--;
			});
		return next;
	}
}
