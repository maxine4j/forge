import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { z } from "zod";

import { PerformanceStore } from "../../src/codex/performance-store.ts";
import { PerformanceTelemetry } from "../../src/codex/performance-telemetry.ts";
import { telemetryArguments } from "../../src/codex/telemetry-receiver.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";

test.each([false, true])(
	"pinned Codex credential-free request telemetry (WebSocket: %s)",
	async (websocket) => {
		const root = await files.mkdtemp(join(tmpdir(), "forge-telemetry-"));
		const batches: unknown[] = [];
		let httpRequests = 0;
		let websocketRequests = 0;
		const events = [
			{ type: "response.created", response: { id: "resp_test" } },
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg_test", role: "assistant", content: [] },
			},
			{
				type: "response.output_text.delta",
				item_id: "msg_test",
				output_index: 0,
				content_index: 0,
				delta: "Hello",
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: {
					type: "message",
					id: "msg_test",
					role: "assistant",
					content: [{ type: "output_text", text: "Hello" }],
				},
			},
			{
				type: "response.completed",
				response: {
					id: "resp_test",
					status: "completed",
					output: [],
					usage: {
						input_tokens: 10,
						output_tokens: 100,
						total_tokens: 110,
						output_tokens_details: { reasoning_tokens: 20 },
					},
				},
			},
		];
		const server = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(Buffer.from(chunk));
			if (req.url === "/v1/traces" || req.url === "/v1/logs") {
				expect(req.headers["authorization"]).toBe("Bearer test-secret");
				batches.push(JSON.parse(Buffer.concat(chunks).toString()));
				res.writeHead(200, { "content-type": "application/json" }).end("{}");
			} else if (req.url?.endsWith("/responses")) {
				httpRequests++;
				res.writeHead(200, { "content-type": "text/event-stream" });
				await sleep(80);
				for (const event of events) {
					res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
					await sleep(20);
				}
				res.end();
			} else res.writeHead(404).end();
		});
		const ws = new WebSocketServer({ server });
		ws.on("connection", (socket) =>
			socket.on("message", async (data) => {
				const request = JSON.parse(data.toString());
				if (request.generate === false) {
					socket.send(JSON.stringify(events.at(-1)));
					return;
				}
				websocketRequests++;
				await sleep(80);
				for (const event of events) {
					socket.send(JSON.stringify(event));
					await sleep(20);
				}
			}),
		);
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Missing listener");
		const url = `http://127.0.0.1:${address.port}`;
		const args = ["exec", "--skip-git-repo-check", "--json", "-m", "mock-model"];
		for (const config of [
			'model_provider="mock"',
			'model_providers.mock.name="Mock"',
			`model_providers.mock.base_url="${url}/v1"`,
			'model_providers.mock.wire_api="responses"',
			`model_providers.mock.supports_websockets=${websocket}`,
			"model_providers.mock.requires_openai_auth=false",
			'otel.metrics_exporter="none"',
		])
			args.push("-c", config);
		args.push(...telemetryArguments(url, "test-secret"));
		args.push("Say hello without tools.");
		const child = spawn(resolve("node_modules/.bin/codex"), args, {
			cwd: root,
			env: { PATH: process.env["PATH"], HOME: root, CODEX_HOME: root },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		try {
			const code = await new Promise((done, reject) => {
				child.on("close", done);
				child.on("error", reject);
			});
			expect(code, stderr).toBe(0);
			expect(stdout).toContain("Hello");
			expect(batches.length).toBeGreaterThan(0);
			expect(websocket ? websocketRequests : httpRequests).toBe(1);
			expect(websocket ? httpRequests : websocketRequests).toBe(0);
			const threadId = JSON.parse(stdout.split("\n").find((line) => line.includes('"thread.started"'))!)
				.thread_id as string;
			const database = new SqliteDatabase(join(root, "performance.sqlite"));
			await database.initialize();
			try {
				const store = new PerformanceStore(database);
				await store.initialize();
				const telemetry = new PerformanceTelemetry(database, store, async (id) => id === threadId);
				await telemetry.initialize();
				// Completion data can arrive before transport/sampling spans and be delivered twice.
				for (const batch of [...batches].reverse()) {
					await telemetry.accept(batch);
					await telemetry.accept(batch);
				}
				const turns = await database.all("SELECT DISTINCT turn_id FROM agent_request_performance");
				expect(turns).toHaveLength(1);
				const turnId = (turns[0] as { turn_id: string }).turn_id;
				const performance = await store.read(threadId, turnId);
				expect(performance).toMatchObject({ turnId, outputTokens: 100, requestCount: 1, state: "complete" });
				expect(performance!.requestDurationMs).toBeGreaterThan(140);
				expect(performance!.requestDurationMs).toBeLessThan(3000);
				expect(performance!.firstTokenLatencyMs).toBeGreaterThan(70);
				expect(performance!.generationDurationMs).toBeGreaterThan(30);
				// Compare with the independent app-server turn span, not just the sampling marker.
				const traceBatch = z.object({
					resourceSpans: z
						.array(
							z.object({
								scopeSpans: z.array(
									z.object({
										spans: z.array(
											z.object({
												name: z.string(),
												attributes: z.array(
													z.object({
														key: z.string(),
														value: z.object({ stringValue: z.string().optional() }),
													}),
												),
											}),
										),
									}),
								),
							}),
						)
						.optional(),
				});
				const canonicalTurns = batches
					.flatMap((batch) => traceBatch.parse(batch).resourceSpans ?? [])
					.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans))
					.filter(
						(span) =>
							span.name === "session_task.turn"
							&& span.attributes.some((a) => a.key === "thread.id" && a.value.stringValue === threadId),
					)
					.map((span) => span.attributes.find((a) => a.key === "turn.id")?.value.stringValue);
				expect(canonicalTurns).toEqual([turnId]);
				const reloaded = new PerformanceTelemetry(database, new PerformanceStore(database), async () => true);
				expect(await reloaded.read(threadId, turnId)).toEqual(performance);
			} finally {
				await database.close();
			}
		} finally {
			child.kill("SIGKILL");
			for (const socket of ws.clients) socket.terminate();
			await new Promise<void>((done) => ws.close(() => done()));
			await new Promise<void>((done) => server.close(() => done()));
			await files.rm(root, { recursive: true, force: true });
		}
	},
	30000,
);
