import { Buffer } from "node:buffer";
import { request } from "node:http";

import { maxRequestBytes } from "@forge/backend-infrastructure/ollama/types";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test, vi } from "vitest";
import { WebSocket } from "ws";

import { WorkerSession } from "../../ollama-client/src/worker-session.ts";
import { PairingLimiter } from "./pairing-limiter.ts";
import { RelayHttp } from "./relay-http.ts";

test("limits real pairing upgrades by forwarded IP and resets after expiry", async () => {
	let now = 0;
	const warn = vi.fn();
	const relay = new RelayHttp(
		Buffer.from("Bearer secret"),
		sleep,
		new PairingLimiter(() => now),
		{ warn },
		() => now,
	);
	await relay.listen("127.0.0.1", 0, 0);
	const url = `ws://127.0.0.1:${relay.ports.pairing}/pair`;
	const response = (headers: Record<string, string>) =>
		new Promise<{ status: number | undefined; retry: string | undefined }>((resolve, reject) => {
			const socket = new WebSocket(url, { headers });
			socket.once("unexpected-response", (_request, reply) => {
				reply.resume();
				resolve({ status: reply.statusCode, retry: reply.headers["retry-after"] });
			});
			socket.once("error", reject);
		});
	try {
		for (let i = 0; i < 5; i++)
			expect((await response({ "X-Forwarded-For": "198.51.100.1, ::ffff:192.0.2.1" })).status).toBe(401);
		now++;
		expect(await response({ "X-Forwarded-For": "192.0.2.1", Authorization: "Bearer secret" })).toEqual({
			status: 429,
			retry: "900",
		});
		expect((await response({ "X-Forwarded-For": "invalid" })).status).toBe(401);
		expect((await response({})).status).toBe(401);
		expect(warn).toHaveBeenCalledOnce();
		now = 900_000;
		const worker = await connect(url, { "X-Forwarded-For": "192.0.2.1", Authorization: "Bearer secret" });
		expect((await response({ "X-Forwarded-For": "192.0.2.1", Authorization: "Bearer secret" })).status).toBe(409);
		worker.terminate();
	} finally {
		await relay.close();
	}
});

test("isolates public ingress and preserves inference responses through an authenticated worker", async () => {
	const bearer = "Bearer fixture-token";
	const relay = new RelayHttp(
		Buffer.from(bearer),
		sleep,
		new PairingLimiter(Date.now),
		{
			warn: () => {},
		},
		Date.now,
	);
	await relay.listen("127.0.0.1", 0, 0);
	const { pairing, inference } = relay.ports;
	const pairingUrl = `ws://127.0.0.1:${pairing}/pair`;
	const headers = { Authorization: bearer };
	const generate = (body = "{}", signal?: AbortSignal) =>
		fetch(`http://127.0.0.1:${inference}/v1/responses`, {
			method: "POST",
			body,
			headers: { "Content-Type": "application/json" },
			signal,
		});
	try {
		expect((await fetch(`http://127.0.0.1:${pairing}/health`)).status).toBe(200);
		expect((await fetch(`http://127.0.0.1:${pairing}/v1/models`)).status).toBe(404);
		expect((await fetch(`http://127.0.0.1:${inference}/v1/models`)).status).toBe(503);
		expect((await fetch(`http://127.0.0.1:${pairing}/v1/responses`, { method: "POST" })).status).toBe(404);
		expect((await generate()).status).toBe(503);
		await expect(connect(pairingUrl)).rejects.toThrow("401");
		await expect(connect(pairingUrl, { ...headers, Origin: "https://example.test" })).rejects.toThrow("403");

		let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
		const cancelUpstream = vi.fn();
		const infer = vi.fn(async (body: Buffer, signal: AbortSignal) => {
			if (body.toString() === '{"stream":true}') {
				return new Response(
					new ReadableStream({
						start: (controller) => {
							stream = controller;
							signal.addEventListener(
								"abort",
								() => {
									cancelUpstream();
									controller.error(signal.reason);
								},
								{ once: true },
							);
						},
					}),
					{
						headers: { "Content-Type": "text/event-stream" },
					},
				);
			}
			return new Response('{"error":{"message":"Unknown model"}}', {
				status: 404,
				headers: { "Content-Type": "application/json" },
			});
		});
		const listModels = vi
			.fn()
			.mockResolvedValueOnce(new Response('{"data":[]}', { headers: { "Content-Type": "application/json" } }))
			.mockResolvedValue(new Response("limited", { status: 429 }));
		const worker = await connect(pairingUrl, headers);
		new WorkerSession(worker, { infer, listModels });
		const models = await fetch(`http://127.0.0.1:${inference}/v1/models`);
		expect(await models.json()).toEqual({ data: [] });
		expect((await fetch(`http://127.0.0.1:${inference}/v1/models`)).status).toBe(429);
		await expect(connect(pairingUrl, headers)).rejects.toThrow("409");
		const failure = await generate();
		expect(failure.status).toBe(404);
		expect(await failure.json()).toEqual({ error: { message: "Unknown model" } });
		const oversized = await new Promise<number | undefined>((resolve, reject) => {
			const upload = request(
				`http://127.0.0.1:${inference}/v1/responses`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json", "Content-Length": maxRequestBytes + 1 },
				},
				(response) => {
					response.resume();
					resolve(response.statusCode);
				},
			);
			upload.once("error", reject);
			upload.flushHeaders();
		});
		expect(oversized).toBe(413);

		const caller = new AbortController();
		const streamed = await generate('{"stream":true}', caller.signal);
		expect(streamed.headers.get("content-type")).toBe("text/event-stream");
		const reader = streamed.body!.getReader();
		const parts = ["event: response.output_text.delta\nda", 'ta: {"delta":"é"}\n\n'];
		for (const part of parts) {
			stream!.enqueue(Buffer.from(part));
			const expected = Buffer.byteLength(part);
			const fragments: Uint8Array[] = [];
			let total = 0;
			while (total < expected) {
				const { value } = await reader.read();
				fragments.push(value!);
				total += value!.length;
			}
			expect(Buffer.concat(fragments).toString()).toBe(part);
		}
		caller.abort();
		await vi.waitFor(() => expect(cancelUpstream).toHaveBeenCalledOnce());

		const interrupted = await generate('{"stream":true}');
		worker.terminate();
		await expect(interrupted.text()).rejects.toThrow();
		const replacement = await connect(pairingUrl, headers);
		new WorkerSession(replacement, { infer, listModels });
		expect((await generate()).status).toBe(404);
	} finally {
		await relay.close();
	}
});

const connect = (url: string, headers?: Record<string, string>): Promise<WebSocket> =>
	new Promise((resolve, reject) => {
		const socket = new WebSocket(url, { headers, maxPayload: maxRequestBytes });
		socket.once("open", () => resolve(socket));
		socket.once("error", reject);
	});

test("routes named workers independently and resets telemetry on reconnect", async () => {
	let now = 1000;
	const bearer = "Bearer fixture";
	const relay = new RelayHttp(
		Buffer.from(bearer),
		sleep,
		new PairingLimiter(() => now),
		{ warn: () => {} },
		() => now,
	);
	await relay.listen("127.0.0.1", 0, 0);
	const { pairing, inference } = relay.ports;
	const bind = (id?: string) =>
		connect(`ws://127.0.0.1:${pairing}/pair`, {
			Authorization: bearer,
			...(id !== undefined ? { "X-Forge-Worker-Id": id } : {}),
		});
	const get = (path: string) => fetch(`http://127.0.0.1:${inference}${path}`);
	const report = {
		type: "telemetry",
		ready: true,
		contextWindow: 32000,
		hostMemory: null,
		loadedModels: null,
		gpus: [],
	};
	try {
		expect(await (await get("/providers")).json()).toEqual({ providers: [] });
		expect((await fetch(`http://127.0.0.1:${pairing}/providers`)).status).toBe(404);
		await bind();
		await expect(bind("Invalid")).rejects.toThrow("400");
		const first = await bind("first");
		const second = await bind("second");
		expect(await (await get("/providers")).json()).toEqual({
			providers: [
				{ workerId: "first", contextWindow: null, concurrency: null },
				{ workerId: "second", contextWindow: null, concurrency: null },
			],
		});
		await expect(bind("first")).rejects.toThrow("409");
		for (const [id, socket] of [
			["first", first],
			["second", second],
		] as const) {
			new WorkerSession(socket, {
				infer: async () => new Response(id),
				listModels: async () => Response.json({ data: [{ id }] }),
			});
			const base = `/${id}/openai/v1`;
			expect(await (await get(`${base}/models`)).json()).toEqual({ data: [{ id }] });
			const response = await fetch(`http://127.0.0.1:${inference}${base}/responses`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: "{}",
			});
			expect(await response.text()).toBe(id);
		}
		expect((await get("/unknown/metrics")).status).toBe(404);
		expect((await get("/first/metrics")).status).toBe(503);
		expect((await fetch(`http://127.0.0.1:${pairing}/first/health`)).status).toBe(404);
		first.send(
			JSON.stringify({
				...report,
				macos: {
					chipName: "Apple M4",
					deviceModel: "MacBook Pro",
					macosVersion: "15.0",
					ollamaVersion: "0.6.0",
					batteryPercent: 0,
					powerWatts: 1.5,
					powerSource: "battery",
					serialNumber: "private",
				},
			}),
		);
		second.send(JSON.stringify({ ...report, ready: false, concurrency: 2 }));
		await vi.waitFor(async () => expect((await get("/first/health")).status).toBe(200));
		await vi.waitFor(async () =>
			expect(await (await get("/second/health")).json()).toMatchObject({ status: "unhealthy" }),
		);
		expect(await (await get("/first/metrics")).json()).toMatchObject({
			workerId: "first",
			receivedAt: new Date(now).toISOString(),
			freshness: "fresh",
			contextWindow: 32000,
			macos: { chipName: "Apple M4", batteryPercent: 0, powerWatts: 1.5 },
		});
		const firstMetrics = await (await get("/first/metrics")).json();
		expect(firstMetrics.macos).not.toHaveProperty("serialNumber");
		expect(await (await get("/second/metrics")).json()).not.toHaveProperty("macos");
		expect((await fetch(`http://127.0.0.1:${pairing}/first/metrics`)).status).toBe(404);
		expect(await (await get("/providers")).json()).toEqual({
			providers: [
				{ workerId: "first", contextWindow: 32000, concurrency: 1 },
				{ workerId: "second", contextWindow: 32000, concurrency: 2 },
			],
		});
		now += 45_000;
		expect(await (await get("/providers")).json()).toEqual({
			providers: [
				{ workerId: "first", contextWindow: null, concurrency: null },
				{ workerId: "second", contextWindow: null, concurrency: null },
			],
		});
		expect(await (await get("/first/metrics")).json()).toMatchObject({ freshness: "stale" });
		const closed = new Promise<void>((resolve) => first.once("close", resolve));
		first.terminate();
		await closed;
		await vi.waitFor(async () =>
			expect(await (await get("/first/metrics")).json()).toMatchObject({ freshness: "offline" }),
		);
		expect(await (await get("/providers")).json()).toEqual({
			providers: [{ workerId: "second", contextWindow: null, concurrency: null }],
		});
		await bind("first");
		expect((await get("/first/metrics")).status).toBe(503);
		expect(await (await get("/providers")).json()).toEqual({
			providers: [
				{ workerId: "first", contextWindow: null, concurrency: null },
				{ workerId: "second", contextWindow: null, concurrency: null },
			],
		});
		expect((await get("/second/openai/v1/models")).status).toBe(200);
		for (let index = 0; index < 14; index++) await bind(`worker-${index}`);
		await expect(bind("over-capacity")).rejects.toThrow("503");
	} finally {
		await relay.close();
	}
});
