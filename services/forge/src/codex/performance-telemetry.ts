import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import type { IPerformanceStore } from "./performance-store.ts";
import type { RequestMeasurement } from "./request-performance.ts";

const attributes = z
	.array(
		z.object({
			key: z.string(),
			value: z.object({
				stringValue: z.string().optional(),
				intValue: z.union([z.string(), z.number()]).optional(),
				boolValue: z.boolean().optional(),
			}),
		}),
	)
	.max(256)
	.default([]);
const span = z.object({
	traceId: z.string().regex(/^[a-f\d]{32}$/i),
	spanId: z.string().regex(/^[a-f\d]{16}$/i),
	parentSpanId: z.string().max(16).default(""),
	name: z.string(),
	startTimeUnixNano: z.string().regex(/^\d{1,20}$/),
	endTimeUnixNano: z.string().regex(/^\d{1,20}$/),
	attributes,
});
const log = z.object({ attributes });
const batch = z.object({
	resourceSpans: z
		.array(z.object({ scopeSpans: z.array(z.object({ spans: z.array(z.unknown()).max(4096) })).max(32) }))
		.max(32)
		.optional(),
	resourceLogs: z
		.array(z.object({ scopeLogs: z.array(z.object({ logRecords: z.array(z.unknown()).max(4096) })).max(32) }))
		.max(32)
		.optional(),
});
const identity = z.string().min(1).max(256);
interface PerformanceFragment {
	id: string;
	kind: "transport" | "stream" | "sampling" | "completion";
	trace: string;
	parent: string;
	thread: string;
	turn: string;
	start: number;
	end: number;
	output: number | null;
	ttft: number | null;
}
const nanos = (value: string) => Number(BigInt(value) / 1000n) / 1000;
const number = (value: unknown): number | null => {
	if (typeof value !== "string" && typeof value !== "number") return null;
	if (typeof value === "string" && !/^\d+$/.test(value)) return null;
	const n = Number(value);
	return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
const fields = (values: z.infer<typeof attributes>) =>
	new Map(values.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.boolValue]));

/** OTLP boundary: resource, account, prompt, response and tool content never leave this parser. */
export const parsePerformanceTelemetry = (input: unknown): PerformanceFragment[] => {
	const parsed = batch.parse(input);
	const result: PerformanceFragment[] = [];
	for (const raw of parsed.resourceSpans?.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)) ?? []) {
		const parsedSpan = span.safeParse(raw);
		if (!parsedSpan.success) continue;
		const s = parsedSpan.data;
		const a = fields(s.attributes);
		let kind: PerformanceFragment["kind"];
		if (s.name === "codex.sampling") kind = "sampling";
		else if (s.name === "stream_request") kind = "stream";
		else if (
			["model_client.stream_responses_api", "model_client.stream_responses_websocket"].includes(s.name)
			&& a.get("websocket.warmup") !== true
		)
			kind = "transport";
		else continue;
		const thread = kind === "sampling" ? identity.safeParse(a.get("conversation.id")) : undefined;
		const turn = kind === "sampling" ? identity.safeParse(a.get("turn.id")) : undefined;
		if (kind === "sampling" && (!thread?.success || !turn?.success)) continue;
		result.push({
			id: `${s.traceId}:${s.spanId}`,
			kind,
			trace: s.traceId,
			parent: `${s.traceId}:${s.parentSpanId}`,
			thread: thread?.data ?? "",
			turn: turn?.data ?? "",
			start: nanos(s.startTimeUnixNano),
			end: nanos(s.endTimeUnixNano),
			output: null,
			ttft: null,
		});
	}
	for (const raw of parsed.resourceLogs?.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords)) ?? []) {
		const parsedLog = log.safeParse(raw);
		if (!parsedLog.success) continue;
		const a = fields(parsedLog.data.attributes);
		if (a.get("event.name") !== "codex.sse_event" || a.get("event.kind") !== "response.completed") continue;
		const thread = identity.safeParse(a.get("conversation.id"));
		const date = z.iso.datetime({ offset: true }).safeParse(a.get("event.timestamp"));
		if (!thread.success || !date.success) continue;
		const end = Date.parse(date.data);
		const output = number(a.get("output_token_count"));
		result.push({
			id: `completion:${thread.data}:${end}:${output === null ? "missing" : "usage"}`,
			kind: "completion",
			trace: "",
			parent: "",
			thread: thread.data,
			turn: "",
			start: end,
			end,
			output,
			ttft: number(a.get("ttft_ms")),
		});
	}
	return result;
};

export interface IAgentPerformance {
	read(threadId: string, turnId: string): ReturnType<IPerformanceStore["read"]>;
	subscribe(listener: (threadId: string) => void): () => void;
}

/** Persists only normalized correlation fragments; source times make export ordering irrelevant. */
export class PerformanceTelemetry implements IAgentPerformance {
	private readonly listeners = new Set<(threadId: string) => void>();
	constructor(
		private readonly database: IDatabase,
		private readonly store: IPerformanceStore,
		private readonly ownsThread: (id: string) => Promise<boolean>,
	) {}
	async initialize(): Promise<void> {
		await this.database.run(`CREATE TABLE IF NOT EXISTS agent_performance_fragments (
			id TEXT PRIMARY KEY, kind TEXT NOT NULL, trace TEXT NOT NULL, parent TEXT NOT NULL,
			thread TEXT NOT NULL, turn TEXT NOT NULL, start REAL NOT NULL, end REAL NOT NULL, output INTEGER, ttft REAL)`);
		await this.database.run(
			"CREATE INDEX IF NOT EXISTS performance_fragment_parent ON agent_performance_fragments(parent,kind)",
		);
		await this.database.run(
			"CREATE INDEX IF NOT EXISTS performance_fragment_thread ON agent_performance_fragments(thread,kind,end)",
		);
		await this.database.run(
			"CREATE INDEX IF NOT EXISTS performance_fragment_trace ON agent_performance_fragments(trace,kind)",
		);
		// Recover an interrupted export write using source data; no running clock is restored.
		let cursor = "";
		while (true) {
			const rows = await this.database.all(
				"SELECT DISTINCT thread FROM agent_performance_fragments WHERE kind='sampling' AND thread>? ORDER BY thread LIMIT 500",
				[cursor],
			);
			if (!rows.length) break;
			const threads = new Set<string>();
			for (const raw of rows) {
				const { thread } = z.object({ thread: z.string() }).parse(raw);
				cursor = thread;
				if (await this.ownsThread(thread)) threads.add(thread);
			}
			await this.reconcile(threads);
		}
	}
	read(threadId: string, turnId: string): ReturnType<IPerformanceStore["read"]> {
		return this.store.read(threadId, turnId);
	}
	subscribe(listener: (threadId: string) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	async accept(input: unknown): Promise<void> {
		const fragments = parsePerformanceTelemetry(input);
		const affected = new Set<string>();
		const traces = new Set<string>();
		let start = Number.MAX_SAFE_INTEGER;
		let end = 0;
		for (const f of fragments) {
			if (f.thread && !(await this.ownsThread(f.thread))) continue;
			start = Math.min(start, f.start);
			end = Math.max(end, f.end);
			await this.database.run(
				`INSERT INTO agent_performance_fragments
				(id,kind,trace,parent,thread,turn,start,end,output,ttft) VALUES(?,?,?,?,?,?,?,?,?,?)
				ON CONFLICT(id) DO UPDATE SET output=COALESCE(excluded.output,output), ttft=COALESCE(excluded.ttft,ttft)`,
				[f.id, f.kind, f.trace, f.parent, f.thread, f.turn, f.start, f.end, f.output, f.ttft],
			);
			if (f.thread) affected.add(f.thread);
			if (f.trace) traces.add(f.trace);
		}
		for (const trace of traces) {
			for (const raw of await this.database.all(
				"SELECT DISTINCT thread FROM agent_performance_fragments WHERE trace=? AND kind='sampling'",
				[trace],
			)) {
				affected.add(z.object({ thread: z.string() }).parse(raw).thread);
			}
		}
		await this.reconcile(affected, { start, end });
	}
	private async reconcile(affected: Set<string>, range?: { start: number; end: number }): Promise<void> {
		for (const threadId of affected) {
			let cursor = "";
			while (true) {
				const rows = await this.database.all(
					`SELECT s.parent AS sampleId, s.id AS cursorId, s.turn AS turnId,
					t.start AS startedAt, t.end AS setupEnd, s.start AS samplingStart, s.end AS samplingEnd
					FROM agent_performance_fragments s
					LEFT JOIN agent_performance_fragments q ON q.parent=s.parent AND q.kind='stream'
					LEFT JOIN agent_performance_fragments t ON t.parent=q.id AND t.kind='transport'
					AND NOT EXISTS (SELECT 1 FROM agent_performance_fragments later
						WHERE later.parent=q.id AND later.kind='transport' AND later.start>t.start)
					WHERE s.kind='sampling' AND s.thread=? AND s.id>? AND s.end>=? AND s.start<=?
					ORDER BY s.id LIMIT 500`,
					[
						threadId,
						cursor,
						Math.max(0, (range?.start ?? 0) - 1),
						(range?.end ?? Number.MAX_SAFE_INTEGER) + 1,
					],
				);
				if (!rows.length) break;
				for (const raw of rows) {
					const row = z
						.object({
							sampleId: z.string(),
							cursorId: z.string(),
							turnId: z.string(),
							startedAt: z.number().nullable(),
							setupEnd: z.number().nullable(),
							samplingStart: z.number(),
							samplingEnd: z.number(),
						})
						.parse(raw);
					cursor = row.cursorId;
					// Codex log source timestamps have millisecond precision. Never use arrival times.
					const logs = await this.database.all(
						`SELECT end,output,ttft FROM agent_performance_fragments
						WHERE kind='completion' AND thread=? AND end>=? AND end<=?
						ORDER BY output IS NULL, end DESC LIMIT 2`,
						[threadId, Math.floor(row.setupEnd ?? row.samplingStart), Math.ceil(row.samplingEnd)],
					);
					const completion = logs[0]
						? z
								.object({ end: z.number(), output: z.number().nullable(), ttft: z.number().nullable() })
								.parse(logs[0])
						: undefined;
					const sample: RequestMeasurement = {
						threadId,
						turnId: row.turnId,
						sampleId: row.sampleId,
						// An incomplete marker has no duration and never enters a denominator.
						startedAt: row.startedAt ?? row.samplingStart,
					};
					if (
						completion
						&& row.startedAt !== null
						&& row.setupEnd !== null
						&& completion.end > row.startedAt
					) {
						sample.completedAt = completion.end;
						if (completion.output !== null) sample.outputTokens = completion.output;
						if (completion.ttft !== null) sample.firstTokenAt = row.setupEnd + completion.ttft;
					}
					await this.store.save(sample);
				}
			}
			for (const listener of this.listeners) listener(threadId);
		}
	}
}
