import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import { messageBytes, readChunk, readFrame, sendFrame } from "@forge/backend-infrastructure/ollama/pairing-socket";
import { readTelemetry } from "@forge/backend-infrastructure/ollama/telemetry";
import { isWorkerId, maxChunkBytes, maxRequestBytes } from "@forge/backend-infrastructure/ollama/types";
import type { ISleep } from "@forge/backend-infrastructure/sleep";
import { WebSocketServer } from "ws";

import { canonicalIp, type PairingLimiter } from "./pairing-limiter.ts";
import type { IInferenceResponse, IWorkerConnection } from "./relay-service.ts";
import { WorkerRegistry } from "./worker-registry.ts";

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
	private bufferedBytes = 0;
	private warnedFallback = false;
	private readonly workers: WorkerRegistry;

	constructor(
		private readonly bearer: Buffer,
		private readonly sleep: ISleep,
		private readonly limiter: PairingLimiter,
		private readonly logger: { warn(message: string): void },
		now: () => number,
	) {
		this.workers = new WorkerRegistry(sleep, now);
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
		const protocols = request.headers["sec-websocket-protocol"]?.split(",").map((value) => value.trim());
		if (
			request.method !== "GET"
			|| request.headers.upgrade?.toLowerCase() !== "websocket"
			|| !/^([+/0-9A-Za-z]{22}==)$/.test(request.headers["sec-websocket-key"] ?? "")
			|| !["8", "13"].includes(request.headers["sec-websocket-version"] ?? "")
			|| (protocols !== undefined
				&& (protocols.some((value) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value))
					|| new Set(protocols).size !== protocols.length))
		)
			return rejectUpgrade(socket, 400, "Bad Request");
		const header = request.headers["x-forwarded-for"];
		const forwarded = (Array.isArray(header) ? header.join(",") : header)?.split(",").at(-1);
		let ip = canonicalIp(forwarded);
		if (!ip) {
			if (!this.warnedFallback) {
				this.warnedFallback = true;
				this.logger.warn("Missing or invalid forwarded client IP; using socket address");
			}
			ip = canonicalIp(request.socket.remoteAddress);
		}
		if (!ip) return rejectUpgrade(socket, 400, "Bad Request");
		const retryAfter = this.limiter.blocked(ip);
		if (retryAfter !== undefined) return rejectUpgrade(socket, 429, "Too Many Requests", retryAfter);
		const candidate = Buffer.from(request.headers.authorization ?? "");
		if (candidate.length !== this.bearer.length || !timingSafeEqual(candidate, this.bearer)) {
			this.limiter.fail(ip);
			return rejectUpgrade(socket, 401, "Unauthorized");
		}
		this.limiter.success(ip);
		const id = request.headers["x-forge-worker-id"];
		if (id !== undefined && (typeof id !== "string" || !isWorkerId(id)))
			return rejectUpgrade(socket, 400, "Bad Request");
		const rejection = this.workers.admission(id);
		if (rejection) return rejectUpgrade(socket, rejection, rejection === 409 ? "Conflict" : "Service Unavailable");

		this.sockets.handleUpgrade(request, socket, head, (webSocket) => {
			const slot = this.workers.connect(id);
			const { service } = slot;
			const worker: IWorkerConnection = {
				send: (frame) => sendFrame(webSocket, frame),
				terminate: () => webSocket.terminate(),
			};
			service.pair(worker);
			const lifetime = new AbortController();
			let alive = true;
			webSocket.on("pong", () => {
				alive = true;
			});
			webSocket.on("close", () => {
				lifetime.abort();
				this.workers.disconnect(id, slot);
				service.disconnect(worker);
			});
			webSocket.on("error", () => webSocket.terminate());
			webSocket.on("message", (raw, binary) => {
				try {
					const bytes = messageBytes(raw);
					if (binary) service.receive(worker, readChunk(bytes));
					else {
						let frame;
						try {
							frame = readFrame(bytes);
						} catch (error) {
							if (id === undefined) throw error;
							this.workers.report(slot, readTelemetry(bytes));
							return;
						}
						service.receive(worker, frame);
					}
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
		if (request.method === "GET" && request.url === "/providers")
			return json(response, 200, { providers: this.workers.inventory() });
		const output = new HttpInferenceResponse(response);
		const named = /^\/([^/]+)\/(openai\/v1\/(?:models|responses)|health|metrics)$/u.exec(request.url ?? "");
		const id = named?.[1];
		const route = named?.[2] ?? request.url;
		const models = request.method === "GET" && (route === "openai/v1/models" || route === "/v1/models");
		const infer = request.method === "POST" && (route === "openai/v1/responses" || route === "/v1/responses");
		const statusRoute = request.method === "GET" && (route === "health" || route === "metrics");
		if ((!models && !infer && !statusRoute) || (id !== undefined && !isWorkerId(id))) {
			output.fail(404, "not_found", "Route not found");
			return;
		}
		const slot = this.workers.get(id);
		if (id !== undefined && !slot) {
			output.fail(404, "not_found", "Unknown worker");
			return;
		}
		if (id !== undefined && slot && statusRoute) {
			const status = this.workers.status(slot);
			const report = slot.report;
			const receivedAt = report ? new Date(report.receivedAt).toISOString() : null;
			const health = { workerId: id, status, receivedAt };
			if (route === "health") return json(response, status === "ready" ? 200 : 503, health);
			if (!report) return json(response, 503, health);
			const { ready, contextWindow, hostMemory, loadedModels, gpus } = report.sample;
			const freshness = status === "offline" || status === "stale" ? status : "fresh";
			return json(response, 200, { ...health, freshness, ready, contextWindow, hostMemory, loadedModels, gpus });
		}
		if (!slot || slot.disconnectedAt !== undefined) {
			output.fail(503, "worker_offline", "Inference worker is unavailable");
			return;
		}
		if (models) {
			const lifetime = new AbortController();
			response.once("close", () => lifetime.abort());
			slot.service.listModels(output, lifetime.signal);
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
		if (slot.reading >= 5) {
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
		const onDisconnect = () => output.fail(503, "worker_offline", "Inference worker disconnected");
		slot.reading++;
		slot.lifetime.signal.addEventListener("abort", onDisconnect, { once: true });
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
			slot.reading--;
			slot.lifetime.signal.removeEventListener("abort", onDisconnect);
		}
		slot.service.infer(Buffer.concat(chunks, size), output, lifetime.signal);
	}
}

const json = (response: ServerResponse, status: number, value: object): void => {
	response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	response.end(JSON.stringify(value));
};

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

const rejectUpgrade = (socket: Duplex, status: number, reason: string, retryAfter?: number): void => {
	socket.end(
		`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n${retryAfter === undefined ? "" : `Retry-After: ${retryAfter}\r\n`}\r\n`,
	);
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
