import { Buffer } from "node:buffer";
import { request } from "node:http";

import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test, vi } from "vitest";
import { WebSocket } from "ws";

import { PairingLimiter } from "./pairing-limiter.ts";
import { RelayHttp } from "./relay-http.ts";
import { RelayService } from "./relay-service.ts";
import { maxRequestBytes } from "./types.ts";
import { WorkerSession } from "./worker-session.ts";

test("limits real pairing upgrades by forwarded IP and resets after expiry", async () => {
	let now = 0;
	const warn = vi.fn();
	const relay = new RelayHttp(
		new RelayService(sleep),
		Buffer.from("Bearer secret"),
		sleep,
		new PairingLimiter(() => now),
		{ warn },
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
	const relay = new RelayHttp(new RelayService(sleep), Buffer.from(bearer), sleep, new PairingLimiter(Date.now), {
		warn: () => {},
	});
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
