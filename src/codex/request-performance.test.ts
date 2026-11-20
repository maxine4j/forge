import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { agentPerformanceSchema, agentViewSchema } from "@forge/contracts/agents";
import { afterEach, beforeEach, expect, test } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { PerformanceStore } from "./performance-store.ts";
import { PerformanceTelemetry, parsePerformanceTelemetry } from "./performance-telemetry.ts";
import { aggregatePerformance, type RequestMeasurement } from "./request-performance.ts";

let root: string;
let database: SqliteDatabase;
let store: PerformanceStore;
beforeEach(async () => {
	root = await files.mkdtemp(join(tmpdir(), "forge-performance-test-"));
	database = new SqliteDatabase(join(root, "forge.sqlite"));
	await database.initialize();
	store = new PerformanceStore(database);
	await store.initialize();
});
afterEach(async () => {
	await database.close();
	await files.rm(root, { recursive: true, force: true });
});

const sample: RequestMeasurement = {
	threadId: "thread",
	turnId: "turn",
	sampleId: "one",
	startedAt: 1000,
	firstTokenAt: 2000,
	completedAt: 6000,
	outputTokens: 100,
};
test("100 output tokens / 5 model seconds = 20 tokens/s independent of tools and approval waits", async () => {
	for (const delay of [0, 60000, 3600000]) {
		const s = {
			...sample,
			startedAt: sample.startedAt + delay,
			firstTokenAt: sample.firstTokenAt! + delay,
			completedAt: sample.completedAt! + delay,
		};
		const result = aggregatePerformance("turn", [s]);
		expect((result.outputTokens * 1000) / result.requestDurationMs).toBe(20);
		expect(result.firstTokenLatencyMs).toBe(1000);
		expect(result.generationDurationMs).toBe(4000);
	}
	await store.save(sample);
	await store.save(sample);
	const result = await store.read("thread", "turn");
	expect(result).toEqual(aggregatePerformance("turn", [sample]));
	await database.close();
	database = new SqliteDatabase(join(root, "forge.sqlite"));
	await database.initialize();
	store = new PerformanceStore(database);
	await store.initialize();
	// Restart has no running timer, and no dependency on the workspace still existing.
	expect(await store.read("thread", "turn")).toEqual(result);
	expect(await store.read("thread", "old-unmeasured-turn")).toBeUndefined();
});

test("multiple requests count output once, retain the first response's latency and omit tool gaps", async () => {
	const samples = [
		sample,
		{
			...sample,
			sampleId: "two",
			startedAt: 3660000,
			firstTokenAt: 3662000,
			completedAt: 3665000,
			outputTokens: 200,
		},
	];
	for (const s of samples.toReversed()) await store.save(s);
	const p = await store.read("thread", "turn");
	expect(p).toEqual(aggregatePerformance("turn", samples));
	expect(p).toMatchObject({
		outputTokens: 300,
		requestCount: 2,
		requestDurationMs: 10000,
		generationDurationMs: 7000,
		firstTokenLatencyMs: 1000,
		state: "complete",
	});
});

test.each([
	{ completedAt: undefined },
	{ outputTokens: undefined },
	{ firstTokenAt: undefined },
	{ completedAt: 1000 },
	{ firstTokenAt: 6000 },
])("missing or invalid telemetry is partial/unavailable, never wall-clock estimated: %o", async (change) => {
	const missing = { ...sample, sampleId: "missing", ...change };
	await store.save(missing);
	const p = await store.read("thread", "turn");
	expect(p?.state).not.toBe("complete");
	expect(p).toEqual(aggregatePerformance("turn", [missing]));
	await store.save({ ...sample, sampleId: "valid" });
	const partial = await store.read("thread", "turn");
	expect(partial?.state).toBe("partial");
	expect(agentPerformanceSchema.safeParse(partial).success).toBe(true);
});

const trace = "a".repeat(32);
const attr = (key: string, value: string | number | boolean) => ({
	key,
	value:
		typeof value === "boolean"
			? { boolValue: value }
			: typeof value === "number"
				? { intValue: String(value) }
				: { stringValue: value },
});
const span = (
	name: string,
	id: string,
	parent: string,
	start: number,
	end: number,
	attributes: ReturnType<typeof attr>[] = [],
) => ({
	name,
	traceId: trace,
	spanId: id.repeat(16),
	parentSpanId: parent.repeat(16),
	startTimeUnixNano: String(BigInt(start) * 1000000n),
	endTimeUnixNano: String(BigInt(end) * 1000000n),
	attributes,
});
const traces = (...spans: ReturnType<typeof span>[]) => ({ resourceSpans: [{ scopeSpans: [{ spans }] }] });
const completion = (thread: string, end: number, output?: number, ttft?: number) => ({
	resourceLogs: [
		{
			scopeLogs: [
				{
					logRecords: [
						{
							attributes: [
								attr("event.name", "codex.sse_event"),
								attr("event.kind", "response.completed"),
								attr("conversation.id", thread),
								attr("event.timestamp", new Date(end).toISOString()),
								...(output === undefined ? [] : [attr("output_token_count", output)]),
								...(ttft === undefined ? [] : [attr("ttft_ms", ttft)]),
								attr("reasoning_token_count", 40),
								attr("input_token_count", 10000),
								attr("user.email", "private@example.com"),
								attr("response", "private content"),
							],
						},
					],
				},
			],
		},
	],
});
const sampling = (thread = "thread", turn = "turn") =>
	span("codex.sampling", "3", "9", 1000, 6001, [attr("conversation.id", thread), attr("turn.id", turn)]);
const transport = span("model_client.stream_responses_api", "1", "2", 1000, 1200);
const stream = span("stream_request", "2", "9", 1000, 1201);

test("delayed, duplicate and reordered batches survive receiver restart and isolate concurrent threads", async () => {
	let telemetry = new PerformanceTelemetry(database, store, async (id) => id === "thread");
	await telemetry.initialize();
	await telemetry.accept(completion("thread", 6000)); // completion before counts
	await telemetry.accept(traces(transport));
	telemetry = new PerformanceTelemetry(database, store, async (id) => id === "thread");
	await telemetry.initialize();
	await telemetry.accept(traces(sampling(), stream));
	let p = await store.read("thread", "turn");
	expect(p?.state).toBe("unavailable");
	await telemetry.accept(completion("thread", 6000, 100, 800));
	p = await store.read("thread", "turn");
	expect(p).toEqual(aggregatePerformance("turn", [sample]));
	await telemetry.accept(completion("thread", 6000, 100, 800));
	await telemetry.accept(traces(sampling(), transport, stream));
	expect(await store.read("thread", "turn")).toEqual(p);
	await telemetry.accept(completion("unrelated", 6000, 999, 30));
	await telemetry.accept(traces({ ...sampling("unrelated"), spanId: "4".repeat(16) }));
	expect(await store.read("unrelated", "turn")).toBeUndefined();
	expect(await store.read("thread", "new-turn")).toBeUndefined();
	await database.run("DELETE FROM agent_request_performance");
	await new PerformanceTelemetry(database, store, async (id) => id === "thread").initialize();
	expect(await store.read("thread", "turn")).toEqual(p);
	const saved = JSON.stringify(await database.all("SELECT * FROM agent_performance_fragments"));
	expect(saved).not.toMatch(/private|input_token|reasoning_token|response/);
});

test("warmups, catalog traffic and failed auth retries never add tokens or duration", async () => {
	const telemetry = new PerformanceTelemetry(database, store, async () => true);
	await telemetry.initialize();
	await telemetry.accept(
		traces(
			sampling(),
			stream,
			span("model_client.stream_responses_websocket", "4", "2", 0, 900, [attr("websocket.warmup", true)]),
			span("catalog", "5", "2", 0, 999),
			span("model_client.stream_responses_api", "6", "2", 500, 900),
			transport,
		),
	);
	await telemetry.accept(completion("thread", 6000, 100, 800));
	expect(await store.read("thread", "turn")).toEqual(aggregatePerformance("turn", [sample]));
});

test("a delayed final transport replaces an earlier retry, and missing transport data marks the turn partial", async () => {
	const telemetry = new PerformanceTelemetry(database, store, async () => true);
	await telemetry.initialize();
	await telemetry.accept(traces(sampling(), stream, span("model_client.stream_responses_api", "6", "2", 500, 900)));
	await telemetry.accept(completion("thread", 6000, 100, 800));
	await telemetry.accept(traces(transport));
	expect(await store.read("thread", "turn")).toEqual(aggregatePerformance("turn", [sample]));
	await telemetry.accept(
		traces(
			span("codex.sampling", "7", "8", 7000, 9000, [attr("conversation.id", "thread"), attr("turn.id", "turn")]),
		),
	);
	expect(await store.read("thread", "turn")).toMatchObject({
		state: "partial",
		requestCount: 1,
		outputTokens: 100,
		requestDurationMs: 5000,
	});
});

test("concurrent owned threads with identical source times remain isolated", async () => {
	const telemetry = new PerformanceTelemetry(database, store, async () => true);
	await telemetry.initialize();
	const other = [sampling("second", "second-turn"), stream, transport].map((s) => ({
		...s,
		traceId: "b".repeat(32),
	}));
	await telemetry.accept(traces(sampling(), stream, transport, ...other));
	await telemetry.accept(completion("second", 6000, 300, 800));
	await telemetry.accept(completion("thread", 6000, 100, 800));
	expect(await store.read("thread", "turn")).toMatchObject({
		state: "complete",
		outputTokens: 100,
		requestDurationMs: 5000,
	});
	expect(await store.read("second", "second-turn")).toMatchObject({
		state: "complete",
		outputTokens: 300,
		requestDurationMs: 5000,
	});
});

test("parsing drops content and requires source timestamps and explicit identities", () => {
	expect(parsePerformanceTelemetry(completion("thread", 6000, 100, 800))).toHaveLength(1);
	expect(parsePerformanceTelemetry(traces(span("codex.sampling", "3", "9", 1, 2)))).toEqual([]);
	expect(
		parsePerformanceTelemetry({
			resourceLogs: [{ scopeLogs: [{ logRecords: [{ observedTimeUnixNano: "9999", attributes: [] }] }] }],
		}),
	).toEqual([]);
});

test("API validation rejects nonfinite rates, inconsistent timing and stale-turn performance", () => {
	const p = aggregatePerformance("turn", [sample]);
	expect(agentPerformanceSchema.safeParse({ ...p, requestDurationMs: Infinity }).success).toBe(false);
	expect(agentPerformanceSchema.safeParse({ ...p, requestDurationMs: 0 }).success).toBe(false);
	expect(agentPerformanceSchema.safeParse({ ...p, generationDurationMs: 6000 }).success).toBe(false);
	const id = "123e4567-e89b-42d3-a456-426614174000";
	expect(
		agentViewSchema.safeParse({
			thread: {
				id,
				projectId: id,
				workspaceId: id,
				title: "Chat",
				createdAt: "2026-11-20T00:00:00.000Z",
				status: "completed",
				turnId: "other",
			},
			items: [],
			requests: [],
			truncated: false,
			performance: p,
		}).success,
	).toBe(false);
});
