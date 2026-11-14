import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { ISleep } from "@forge/backend-infrastructure/sleep";
import { WebSocketServer } from "ws";

import { messageBytes, readChunk, readFrame, sendFrame } from "./pairing-socket.ts";
import type { IInferenceResponse, IRelayService, IWorkerConnection } from "./relay-service.ts";
import { maxChunkBytes, maxRequestBytes } from "./types.ts";

const maxBufferedRequestBytes = 2 * maxRequestBytes;

export class RelayHttp {
	private readonly pairing = createServer((request, response) => {
		const healthy = request.method === "GET" && request.url === "/health";
		response.writeHead(healthy ? 200 : 404).end();
	});
	private readonly inference = createServer((request, response) => {
		void this.respond(request, response).catch(() =>
			new HttpInferenceResponse(response).fail(400, "invalid_request", "Could not read inference request"),
		);
	});
	private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: maxChunkBytes });
	private readonly lifetime = new AbortController();
	private reading = 0;
	private bufferedBytes = 0;
	private paired = false;

	constructor(
		private readonly service: IRelayService,
		private readonly bearer: Buffer,
		private readonly sleep: ISleep,
	) {
		this.pairing.on("upgrade", (request, socket, head) => this.upgrade(request, socket, head));
	}

	async listen(host: string, publicPort: number, internalPort: number): Promise<void> {
		try {
			await listen(this.pairing, publicPort, host);
			await listen(this.inference, internalPort, host);
		} catch (error) {
			await this.close();
			throw error;
		}
	}

	get ports(): { pairing: number; inference: number } {
		return { pairing: port(this.pairing), inference: port(this.inference) };
	}

	async close(): Promise<void> {
		this.lifetime.abort();
		for (const socket of this.sockets.clients) socket.terminate();
		await Promise.all([
			new Promise<void>((resolve) => this.sockets.close(() => resolve())),
			...[this.pairing, this.inference].map(
				(server) =>
					new Promise<void>((resolve) => {
						server.close(() => resolve());
						server.closeAllConnections();
					}),
			),
		]);
	}

	private upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
		if (request.url !== "/pair") return rejectUpgrade(socket, 404, "Not Found");
		if (request.headers.origin !== undefined) return rejectUpgrade(socket, 403, "Forbidden");
		const candidate = Buffer.from(request.headers.authorization ?? "");
		if (candidate.length !== this.bearer.length || !timingSafeEqual(candidate, this.bearer))
			return rejectUpgrade(socket, 401, "Unauthorized");
		if (this.paired) return rejectUpgrade(socket, 409, "Conflict");

		this.sockets.handleUpgrade(request, socket, head, (webSocket) => {
			const worker: IWorkerConnection = {
				send: (frame) => sendFrame(webSocket, frame),
				terminate: () => webSocket.terminate(),
			};
			if (!this.service.pair(worker)) return webSocket.terminate();
			this.paired = true;
			const lifetime = new AbortController();
			let alive = true;
			webSocket.on("pong", () => {
				alive = true;
			});
			webSocket.on("close", () => {
				lifetime.abort();
				this.service.disconnect(worker);
				this.paired = false;
			});
			webSocket.on("error", () => webSocket.terminate());
			webSocket.on("message", (raw, binary) => {
				try {
					const bytes = messageBytes(raw);
					this.service.receive(worker, binary ? readChunk(bytes) : readFrame(bytes));
				} catch {
					webSocket.terminate();
				}
			});
			void (async () => {
				while (!lifetime.signal.aborted && !this.lifetime.signal.aborted) {
					await this.sleep(15_000, lifetime.signal);
					if (!alive) return webSocket.terminate();
					alive = false;
					webSocket.ping();
				}
			})().catch(() => webSocket.terminate());
		});
	}

	private async respond(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const output = new HttpInferenceResponse(response);
		if (request.method !== "POST" || request.url !== "/v1/responses") {
			output.fail(404, "not_found", "Route not found");
			return;
		}
		if (request.headers["content-type"]?.split(";").at(0)?.trim().toLowerCase() !== "application/json") {
			output.fail(415, "invalid_content_type", "Expected application/json");
			return;
		}
		if (Number(request.headers["content-length"]) > maxRequestBytes) {
			output.fail(413, "request_too_large", "Inference request exceeds 16 MiB");
			return;
		}
		if (this.reading >= 5) {
			output.fail(429, "queue_full", "Inference request capacity exceeded");
			return;
		}
		const lifetime = new AbortController();
		let reserved = 0;
		response.once("close", () => {
			lifetime.abort();
			this.bufferedBytes -= reserved;
			reserved = 0;
		});
		const chunks: Buffer[] = [];
		let size = 0;
		this.reading++;
		try {
			for await (const chunk of request.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) {
				if (lifetime.signal.aborted) return;
				size += chunk.length;
				if (size > maxRequestBytes) {
					output.fail(413, "request_too_large", "Inference request exceeds 16 MiB");
					return;
				}
				if (this.bufferedBytes + chunk.length > maxBufferedRequestBytes) {
					output.fail(429, "queue_full", "Inference request byte budget exceeded");
					return;
				}
				this.bufferedBytes += chunk.length;
				reserved += chunk.length;
				chunks.push(chunk);
			}
		} finally {
			this.reading--;
		}
		this.service.infer(Buffer.concat(chunks, size), output, lifetime.signal);
	}
}

class HttpInferenceResponse implements IInferenceResponse {
	constructor(private readonly response: ServerResponse) {}

	headers(status: number, contentType: string): void {
		this.response.writeHead(status, contentType ? { "Content-Type": contentType } : {});
		this.response.flushHeaders();
	}

	write(chunk: Buffer): Promise<void> {
		return new Promise((resolve, reject) => {
			this.response.write(chunk, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	end(): void {
		this.response.end();
	}

	fail(status: number, code: string, message: string): void {
		if (this.response.destroyed || this.response.writableEnded) return;
		if (this.response.headersSent) {
			this.response.destroy();
			return;
		}
		this.response.writeHead(status, { "Content-Type": "application/json", Connection: "close" });
		this.response.end(JSON.stringify({ error: { type: "relay_error", code, message } }));
	}
}

const rejectUpgrade = (socket: Duplex, status: number, reason: string): void => {
	socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

const listen = (server: ReturnType<typeof createServer>, port: number, host: string): Promise<void> =>
	new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});

const port = (server: ReturnType<typeof createServer>): number => {
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Relay listener is unavailable");
	return address.port;
};
