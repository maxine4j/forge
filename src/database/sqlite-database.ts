import { Worker } from "node:worker_threads";

import type { SqlStatement, SqlValue } from "./types.ts";

export class DatabaseError extends Error {
	constructor(options?: ErrorOptions) {
		super("Database operation failed", options);
		this.name = "DatabaseError";
	}
}
export interface IDatabase {
	/** Opens one serialized worker connection. All failures reject with DatabaseError. */
	initialize(): Promise<void>;
	/** Internal prepared SQL only; at most 1000 result rows. Driver values stay in this adapter. */
	all(sql: string, parameters?: SqlValue[]): Promise<unknown[]>;
	run(sql: string, parameters?: SqlValue[]): Promise<number>;
	/** Atomically executes at most 100 statements. No async callbacks inside a transaction. */
	transaction(statements: SqlStatement[]): Promise<void>;
	/** Drains accepted work and closes the connection. Idempotent. */
	close(): Promise<void>;
}

export class SqliteDatabase implements IDatabase {
	private worker?: Worker;
	private ready?: Promise<void>;
	private closed = false;
	private sequence = 0;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	private closing?: Promise<void>;
	constructor(
		private readonly path: string,
		private readonly createWorker: (url: URL, path: string) => Worker = (url, path) =>
			new Worker(url, { workerData: { path } }),
	) {}

	async initialize(): Promise<void> {
		if (this.closed) throw new DatabaseError();
		if (this.ready) return this.ready;
		let worker: Worker;
		try {
			worker = this.createWorker(
				new URL(import.meta.url.endsWith(".ts") ? "./sqlite-worker.ts" : "./sqlite-worker.js", import.meta.url),
				this.path,
			);
		} catch (cause) {
			this.closed = true;
			throw new DatabaseError({ cause });
		}
		this.worker = worker;
		this.ready = new Promise<void>((resolve, reject) => {
			worker.on("message", (message) => {
				if (message.ready) {
					resolve();
					return;
				}
				const request = this.pending.get(message.id);
				if (!request) return;
				this.pending.delete(message.id);
				if (message.error) request.reject(new DatabaseError({ cause: new Error(message.error) }));
				else request.resolve(message.result);
			});
			const fail = (cause: unknown) => {
				this.closed = true;
				const error = new DatabaseError({ cause });
				reject(error);
				for (const request of this.pending.values()) request.reject(error);
				this.pending.clear();
			};
			worker.on("error", fail);
			worker.on("exit", (code) => fail(new Error(`SQLite worker exited (${code})`)));
		});
		return this.ready;
	}
	async all(sql: string, parameters: SqlValue[] = []): Promise<unknown[]> {
		return (await this.request({ op: "all", sql, parameters })) as unknown[];
	}
	async run(sql: string, parameters: SqlValue[] = []): Promise<number> {
		return (await this.request({ op: "run", sql, parameters })) as number;
	}
	async transaction(statements: SqlStatement[]): Promise<void> {
		if (statements.length > 100) throw new DatabaseError();
		await this.request({ op: "transaction", statements });
	}
	async close(): Promise<void> {
		if (this.closing) return this.closing;
		if (!this.worker || this.closed) return;
		this.closing = (async () => {
			try {
				await this.request({ op: "close" });
			} finally {
				this.closed = true;
				await this.worker!.terminate();
			}
		})();
		return this.closing;
	}
	private async request(message: object): Promise<unknown> {
		if (this.closed || this.closing || !this.ready) throw new DatabaseError();
		await this.ready;
		if (this.closed) throw new DatabaseError();
		if (this.pending.size >= 100) throw new DatabaseError();
		const id = ++this.sequence;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			try {
				this.worker!.postMessage({ ...message, id });
			} catch (cause) {
				this.pending.delete(id);
				reject(new DatabaseError({ cause }));
			}
		});
	}
}
