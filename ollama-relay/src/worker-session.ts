import { Buffer } from "node:buffer";

import type { WebSocket } from "ws";

import { messageBytes, readFrame, sendFrame } from "./pairing-socket.ts";
import { maxChunkBytes } from "./types.ts";

export interface IOllamaClient {
	infer(body: Buffer, signal: AbortSignal): Promise<Response>;
}

interface RequestState {
	id: number;
	lifetime: AbortController;
	acknowledge?: () => void;
}

export class WorkerSession {
	private pendingId?: number;
	private latestId = 0;
	private active?: RequestState;
	private finished = Promise.resolve();

	constructor(
		private readonly socket: WebSocket,
		private readonly ollama: IOllamaClient,
	) {
		socket.on("close", () => this.active?.lifetime.abort());
		socket.on("error", () => socket.terminate());
		socket.on("message", (raw, binary) => {
			try {
				const bytes = messageBytes(raw);
				if (binary) this.start(bytes);
				else this.control(bytes);
			} catch {
				socket.terminate();
			}
		});
	}

	async settle(): Promise<void> {
		await this.finished;
	}

	private control(bytes: Buffer): void {
		const { type, id } = readFrame(bytes);
		if (type === "request" && !this.active && this.pendingId === undefined && id > this.latestId) {
			this.pendingId = id;
			this.latestId = id;
		} else if (type === "ack" && this.active?.id === id && this.active.acknowledge) {
			this.active.acknowledge();
		} else if (type === "cancel" && this.active?.id === id) {
			this.active.lifetime.abort();
		} else if (type !== "cancel" || id > this.latestId || id === this.pendingId) {
			throw new Error("Unexpected relay control frame");
		}
	}

	private start(body: Buffer): void {
		if (this.pendingId === undefined || this.active) throw new Error("Unexpected inference body");
		const request: RequestState = { id: this.pendingId, lifetime: new AbortController() };
		this.pendingId = undefined;
		this.active = request;
		this.finished = this.stream(request, body).catch(() => this.socket.terminate());
	}

	private async stream(request: RequestState, body: Buffer): Promise<void> {
		const {
			id,
			lifetime: { signal },
		} = request;
		let terminal: "end" | "failed" | "cancelled" = "end";
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const upstream = await this.ollama.infer(body, signal);
			reader = upstream.body?.getReader();
			signal.throwIfAborted();
			await sendFrame(this.socket, {
				type: "headers",
				id,
				status: upstream.status,
				contentType: upstream.headers.get("content-type") ?? "",
			});
			while (reader) {
				const { value, done } = await reader.read();
				if (done) break;
				const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
				for (let offset = 0; offset < bytes.length; offset += maxChunkBytes) {
					await this.write(request, bytes.subarray(offset, offset + maxChunkBytes));
				}
			}
		} catch {
			terminal = "failed";
		} finally {
			if (reader && (signal.aborted || terminal === "failed")) await reader.cancel().catch(() => {});
			reader?.releaseLock();
			this.active = undefined;
		}
		if (signal.aborted) terminal = "cancelled";
		await sendFrame(this.socket, { type: terminal, id });
	}

	private async write(request: RequestState, bytes: Buffer): Promise<void> {
		const {
			lifetime: { signal },
		} = request;
		signal.throwIfAborted();
		let onAbort: () => void = () => {};
		const acknowledged = new Promise<void>((resolve, reject) => {
			request.acknowledge = resolve;
			onAbort = () => reject(signal.reason);
			signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			await Promise.all([sendFrame(this.socket, bytes), acknowledged]);
		} finally {
			signal.removeEventListener("abort", onAbort);
			request.acknowledge = undefined;
		}
	}
}
