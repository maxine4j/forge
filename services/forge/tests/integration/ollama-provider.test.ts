import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { maxRequestBytes } from "@forge/backend-infrastructure/ollama/types";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { z } from "zod";

import { OllamaClient } from "../../../ollama-client/src/ollama-client.ts";
import { WorkerSession } from "../../../ollama-client/src/worker-session.ts";
import { PairingLimiter } from "../../../ollama-relay/src/pairing-limiter.ts";
import { RelayHttp } from "../../../ollama-relay/src/relay-http.ts";
import { AccountProcess } from "../../src/accounts/account-process.ts";
import { CodexConnection } from "../../src/accounts/codex-connection.ts";
import { AccessService } from "../../src/auth/access-service.ts";
import { CodexAgentClient } from "../../src/codex/codex-agent-client.ts";
import { CodexUsageClient } from "../../src/codex/codex-usage-client.ts";
import { CostStore } from "../../src/cost/cost-store.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { ModelProviderService } from "../../src/model-providers/model-provider-service.ts";
import { ModelProviderStore } from "../../src/model-providers/model-provider-store.ts";
import { pollOllamaRelay } from "../../src/model-providers/ollama-relay-poller.ts";

test("discovers a connected named worker and persists refreshed capabilities through restart", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-discovery-"));
	let database = new SqliteDatabase(join(root, "forge.sqlite"));
	const relay = new RelayHttp(
		Buffer.from("Bearer secret"),
		sleep,
		new PairingLimiter(Date.now),
		{ warn: () => {} },
		Date.now,
	);
	let socket: WebSocket | undefined;
	try {
		await database.initialize();
		let store = new ModelProviderStore(database);
		await store.initialize();
		await relay.listen("127.0.0.1", 0, 0);
		const origin = `http://127.0.0.1:${relay.ports.inference}`;
		socket = new WebSocket(`ws://127.0.0.1:${relay.ports.pairing}/pair`, {
			headers: { Authorization: "Bearer secret", "X-Forge-Worker-Id": "gpu-1" },
		});
		await new Promise<void>((resolve, reject) => {
			socket!.once("open", resolve);
			socket!.once("error", reject);
		});
		const report = {
			type: "telemetry",
			ready: true,
			contextWindow: 48000,
			concurrency: 1,
			hostMemory: null,
			loadedModels: null,
			gpus: [],
		};
		socket.send(JSON.stringify(report));
		await vi.waitFor(async () =>
			expect(await (await fetch(`${origin}/providers`)).json()).toEqual({
				providers: [{ workerId: "gpu-1", contextWindow: 48000, concurrency: 1 }],
			}),
		);
		const access = new AccessService({ owner: "owner", origin: "https://forge.test" });
		const service = () =>
			new ModelProviderService(store, access, randomUUID, async () => {
				throw new Error("unused");
			});
		const poll = async (current: ModelProviderService) => {
			const abort = new AbortController();
			await pollOllamaRelay(
				origin,
				fetch,
				sleep,
				async (workers) => {
					await current.reconcileRelay(origin, workers, () => {
						throw new Error("conflict");
					});
					abort.abort();
				},
				(error) => {
					throw error;
				},
				abort.signal,
			);
		};
		await poll(service());
		const initial = (await store.list())[0]!;
		expect(initial).toMatchObject({ name: "gpu-1", contextWindow: 48000, supportedConcurrency: 1 });
		await database.close();
		database = new SqliteDatabase(join(root, "forge.sqlite"));
		await database.initialize();
		store = new ModelProviderStore(database);
		await store.initialize();
		await poll(service());
		expect((await store.list())[0]?.id).toBe(initial.id);
		socket.send(JSON.stringify({ ...report, contextWindow: 96000 }));
		await vi.waitFor(async () =>
			expect(await (await fetch(`${origin}/providers`)).json()).toMatchObject({
				providers: [{ contextWindow: 96000 }],
			}),
		);
		await poll(service());
		expect((await store.get(initial.id))?.contextWindow).toBe(96000);
		socket.terminate();
		await vi.waitFor(async () =>
			expect(await (await fetch(`${origin}/providers`)).json()).toEqual({ providers: [] }),
		);
		await poll(service());
		expect((await store.list())[0]?.id).toBe(initial.id);
	} finally {
		socket?.terminate();
		await relay.close();
		await database.close();
		await files.rm(root, { recursive: true, force: true });
	}
});

test("pinned Codex streams through the relay and resumes after restart without sending OpenAI auth", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-provider-test-"));
	const requests: { url?: string; headers: Record<string, unknown>; body: string }[] = [];
	const syntheticToken = "forge-test-synthetic-chatgpt-token";
	const accountAuthorization: (string | undefined)[] = [];
	const server = createServer((request, response) => {
		if (request.url?.endsWith("/accounts/check") && request.url.startsWith("/chatgpt/")) {
			accountAuthorization.push(request.headers.authorization);
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					accounts: [
						{
							id: "synthetic-account",
							plan_type: "plus",
							workspace_backend_origin: "NO_CONSTRAINT",
							account_routing_override: "NO_CONSTRAINT",
						},
					],
				}),
			);
			return;
		}
		if (request.url !== "/v1/responses") {
			response.writeHead(404);
			response.end();
			return;
		}
		request.setEncoding("utf8");
		let body = "";
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			requests.push({ url: request.url, headers: request.headers, body });
			const id = `response-${requests.length}`;
			const input = JSON.parse(body);
			const needsTool =
				body.includes("Run the fixture command") && !body.includes('"type":"function_call_output"');
			const compact = body.includes("CONTEXT CHECKPOINT COMPACTION");
			const answer = compact
				? "The fixture conversation is ready to continue."
				: body.includes("Plan a greeting.")
					? "<proposed_plan>\n# Greeting\nSay hello.\n</proposed_plan>"
					: "Fixture answer";
			const output = needsTool
				? {
						id: "fixture-tool",
						type: "function_call",
						name: "exec_command",
						call_id: "fixture-call",
						arguments: JSON.stringify({ cmd: "echo forge-provider-tool" }),
						status: "completed",
					}
				: {
						id: `message-${requests.length}`,
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: answer, annotations: [] }],
					};
			if (input.model !== "fixture:latest" || body.includes("Fail the fixture turn")) {
				response.writeHead(500, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ error: { type: "api_error", message: "Private template error" } }));
				return;
			}
			const events = [
				{ type: "response.created", response: { id } },
				{ type: "response.output_item.done", output_index: 0, item: output },
				{
					type: "response.completed",
					response: {
						id,
						status: "completed",
						output: [output],
						usage: {
							input_tokens: body.includes("Trigger automatic compaction") && !compact ? 2000 : 20,
							input_tokens_details: { cached_tokens: 8 },
							output_tokens: 5,
							total_tokens: body.includes("Trigger automatic compaction") && !compact ? 2005 : 25,
						},
					},
				},
			];
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
		});
	});
	const processes = new AccountProcess(
		{
			dataDirectory: root,
			path: process.env["PATH"] ?? "",
			codexExecutable: resolve("node_modules/.bin/codex"),
			githubExecutable: "gh",
		},
		sleep,
	);
	const connection = new CodexConnection(processes, sleep);
	const db = new SqliteDatabase(join(root, "forge.sqlite"));
	const costs = new CostStore(db);
	const sample = vi.fn(async () => {});
	let benchmark = "gpt-5.4";
	const usage = new CodexUsageClient(
		connection,
		(turn) => costs.save(turn),
		() => new Date(),
		async () => ({ localCurrency: "EUR", monthlyPlanLocal: 30, usdToAud: 1.5 }),
		sample,
		async (providerId) => (providerId === "local" ? benchmark : undefined),
	);
	const bearer = "Bearer synthetic-ollama-pairing-token";
	const relay = new RelayHttp(
		Buffer.from(bearer),
		sleep,
		new PairingLimiter(Date.now),
		{
			warn: () => {},
		},
		Date.now,
	);
	let socket: WebSocket | undefined;
	try {
		await db.initialize();
		await costs.initialize(new Date().toISOString());
		await processes.initialize();
		const claims = Buffer.from(
			JSON.stringify({
				email: "synthetic@example.test",
				"https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "synthetic-account" },
			}),
		).toString("base64url");
		await files.writeFile(
			join(root, "codex", "auth.json"),
			JSON.stringify({
				auth_mode: "chatgpt",
				tokens: {
					id_token: `e30.${claims}.fixture`,
					access_token: syntheticToken,
					refresh_token: "synthetic-refresh-token",
					account_id: "synthetic-account",
				},
				last_refresh: new Date().toISOString(),
			}),
			{ mode: 0o600 },
		);
		await new Promise<void>((ready, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", ready);
		});
		const address = z.object({ port: z.number() }).parse(server.address());
		await relay.listen("127.0.0.1", 0, 0);
		const worker = new WebSocket(`ws://127.0.0.1:${relay.ports.pairing}/pair`, {
			headers: { Authorization: bearer, "X-Forge-Worker-Id": "fixture-worker" },
			maxPayload: maxRequestBytes,
		});
		socket = worker;
		const workerRequests: Headers[] = [];
		new WorkerSession(
			worker,
			new OllamaClient(`http://127.0.0.1:${address.port}`, (url, init) => {
				workerRequests.push(new Headers(init?.headers));
				return fetch(url, init);
			}),
		);
		await new Promise<void>((ready, reject) => {
			worker.once("open", ready);
			worker.once("error", reject);
		});
		await files.writeFile(
			join(root, "codex", "config.toml"),
			`chatgpt_base_url = "http://127.0.0.1:${address.port}/chatgpt/"\n[analytics]\nenabled = false\n`,
			{ mode: 0o600 },
		);
		await files.mkdir(join(root, "codex", "rules"), { recursive: true });
		await files.writeFile(
			join(root, "codex", "rules", "default.rules"),
			'prefix_rule(pattern=["echo", "forge-provider-tool"], decision="prompt")\n',
			{ mode: 0o600 },
		);
		const provider = {
			kind: "ollama",
			endpoint: `http://127.0.0.1:${relay.ports.inference}/fixture-worker/openai/v1`,
			model: "fixture:latest",
		} as const;
		const client = new CodexAgentClient(connection, files.realpath, randomUUID, usage);
		const path = await files.realpath(root);
		await connection.initialize();
		// Codex requires HTTPS for discovered ChatGPT origins. Observe the signed-in
		// account request before that check to prove the synthetic token was loaded.
		await vi.waitFor(() => expect(accountAuthorization).toContain(`Bearer ${syntheticToken}`));
		const id = await client.start(path, provider);
		const compactId = await client.start(path, { ...provider, compactionThresholdTokens: 1000 });
		const compactStart = requests.length;
		await client.send(compactId, path, "Trigger automatic compaction", { permissions: "ask" });
		await vi.waitFor(() => expect(client.read(compactId).status).toBe("completed"), { timeout: 10000 });
		await client.send(compactId, path, "Continue after compaction", { permissions: "ask" });
		await vi.waitFor(() => expect(client.read(compactId).status).toBe("completed"), { timeout: 10000 });
		const compactRequests = requests.slice(compactStart);
		const summaryIndex = compactRequests.findIndex(({ body }) => body.includes("CONTEXT CHECKPOINT COMPACTION"));
		const followupIndex = compactRequests.findIndex(({ body }) => body.includes("Continue after compaction"));
		expect(summaryIndex).toBeGreaterThan(0);
		expect(followupIndex).toBeGreaterThan(summaryIndex);
		await client.send(
			id,
			path,
			"Run the fixture command.",
			{ permissions: "ask" },
			{ projectId: "fixture", providerId: "local", phase: "chat" },
		);
		await vi.waitFor(
			() => expect(client.read(id).requests).toEqual([expect.objectContaining({ kind: "command" })]),
			{ timeout: 5000 },
		);
		client.reply(id, { requestId: client.read(id).requests.at(0)!.id, decision: "accept" });
		await vi.waitFor(() => expect(client.read(id).status).toBe("completed"), { timeout: 5000 });
		await vi.waitFor(async () =>
			expect((await costs.read()).turns).toMatchObject([
				{
					providerId: "local",
					providerKind: "ollama",
					phase: "chat",
					input: 40,
					cached: 16,
					output: 10,
					billing: {
						usdToAud: 1.5,
						benchmark: { model: "gpt-5.4", rates: { input: 2.5, cached: 0.25, output: 15 } },
					},
				},
			]),
		);
		const autoId = await client.start(path, provider);
		const beforeAuto = requests.length;
		await expect(
			client.send(autoId, path, "Run the fixture command.", { permissions: "approve-for-me" }),
		).rejects.toMatchObject({ code: "unsupported-settings" });
		expect(requests).toHaveLength(beforeAuto);
		expect(
			requests.some(
				({ body }) => body.includes('"type":"function_call_output"') && body.includes("forge-provider-tool"),
			),
		).toBe(true);
		await connection.restart();
		benchmark = "gpt-6.1-sol";
		expect((await client.resume(id, path, provider)).items).toContainEqual(
			expect.objectContaining({ text: "Fixture answer" }),
		);
		await client.send(
			id,
			path,
			"Plan a greeting.",
			{ permissions: "ask" },
			{
				projectId: "fixture",
				providerId: "local",
				ticketId: "TASK-1",
				phase: "planning",
			},
		);
		await vi.waitFor(() => expect(client.read(id).status).toBe("completed"), { timeout: 5000 });
		expect(client.read(id).plan).toContain("# Greeting");
		await vi.waitFor(async () => {
			const { turns } = await costs.read();
			expect(turns).toMatchObject([
				{ input: 40, cached: 16, output: 10, billing: { benchmark: { model: "gpt-5.4" } } },
				{
					providerKind: "ollama",
					phase: "planning",
					ticketId: "TASK-1",
					input: 20,
					cached: 8,
					output: 5,
					billing: { benchmark: { model: "gpt-6.1-sol" } },
				},
			]);
			expect(turns.map((turn) => turn.apiUsd)).toEqual([undefined, undefined]);
		});
		const beforeCompact = requests.length;
		const compactionItems: unknown[] = [];
		let compactTurnCompleted = false;
		const unsubscribe = connection.subscribe((method, params) => {
			if (method === "item/completed" && z.object({ threadId: z.literal(id) }).safeParse(params).success)
				compactionItems.push(params);
			if (method === "turn/completed" && z.object({ threadId: z.literal(id) }).safeParse(params).success)
				compactTurnCompleted = true;
		});
		try {
			await connection.request("thread/compact/start", { threadId: id });
			await vi.waitFor(() => expect(requests.length).toBeGreaterThan(beforeCompact));
			await vi.waitFor(
				() =>
					expect(compactionItems).toContainEqual(
						expect.objectContaining({
							item: expect.objectContaining({ type: "contextCompaction" }),
						}),
					),
				{ timeout: 5000 },
			);
			await vi.waitFor(() => expect(compactTurnCompleted).toBe(true), { timeout: 5000 });
		} finally {
			unsubscribe();
		}
		// The compaction item finishes before its owning turn releases the thread.
		await vi.waitFor(() => expect(client.read(id).status).toBe("completed"), { timeout: 5000 });
		await client.send(id, path, "Fail the fixture turn.", { permissions: "ask" });
		await vi.waitFor(() => expect(client.read(id).status).toBe("failed"), { timeout: 40000, interval: 100 });
		expect(client.read(id).turnFailure).toBe("provider-request");
		expect(JSON.stringify(client.read(id))).not.toContain("Private template error");
		expect(sample).not.toHaveBeenCalled();
		expect(requests.length).toBeGreaterThanOrEqual(2);
		for (const headers of workerRequests) {
			expect(headers.has("authorization")).toBe(false);
			expect(headers.has("chatgpt-account-id")).toBe(false);
		}
		for (const request of requests) {
			expect(request.url).toBe("/v1/responses");
			expect(request.headers).not.toHaveProperty("authorization");
			expect(request.headers).not.toHaveProperty("chatgpt-account-id");
			expect(JSON.stringify(request)).not.toContain(syntheticToken);
			expect(JSON.parse(request.body)).toMatchObject({ model: provider.model, stream: true });
		}
	} finally {
		await usage.close();
		await connection.close();
		await db.close();
		socket?.terminate();
		await relay.close();
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		await files.rm(root, { recursive: true, force: true });
	}
}, 60000);
