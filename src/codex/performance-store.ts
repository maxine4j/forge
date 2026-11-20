import type { AgentPerformance } from "@forge/contracts/agents";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import { aggregatePerformance, type RequestMeasurement } from "./request-performance.ts";

const measurement = z.object({
	threadId: z.string(),
	turnId: z.string(),
	sampleId: z.string(),
	startedAt: z.number().nonnegative(),
	completedAt: z
		.number()
		.nonnegative()
		.nullish()
		.transform((value) => value ?? undefined),
	firstTokenAt: z
		.number()
		.nonnegative()
		.nullish()
		.transform((value) => value ?? undefined),
	outputTokens: z
		.int()
		.nonnegative()
		.nullish()
		.transform((value) => value ?? undefined),
});

export interface IPerformanceStore {
	save(sample: RequestMeasurement): Promise<void>;
	read(threadId: string, turnId: string): Promise<AgentPerformance | undefined>;
}

export class PerformanceStore implements IPerformanceStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.database.run(`CREATE TABLE IF NOT EXISTS agent_request_performance (
			thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, sample_id TEXT NOT NULL,
			started_at REAL NOT NULL, completed_at REAL, first_token_at REAL, output_tokens INTEGER,
			PRIMARY KEY(thread_id, turn_id, sample_id))`);
	}
	async ownsThread(threadId: string): Promise<boolean> {
		return (
			(
				await this.database.all(
					"SELECT id FROM agent_threads WHERE json_extract(record,'$.codexId')=? LIMIT 1",
					[threadId],
				)
			).length > 0
		);
	}
	async save(sample: RequestMeasurement): Promise<void> {
		const s = measurement.parse(sample);
		await this.database.run(
			`INSERT INTO agent_request_performance
			(thread_id, turn_id, sample_id, started_at, completed_at, first_token_at, output_tokens)
			VALUES (?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(thread_id, turn_id, sample_id) DO UPDATE SET
			started_at = excluded.started_at,
			completed_at = COALESCE(excluded.completed_at, completed_at),
			first_token_at = COALESCE(excluded.first_token_at, first_token_at),
			output_tokens = COALESCE(excluded.output_tokens, output_tokens)`,
			[
				s.threadId,
				s.turnId,
				s.sampleId,
				s.startedAt,
				s.completedAt ?? null,
				s.firstTokenAt ?? null,
				s.outputTokens ?? null,
			],
		);
	}
	async read(threadId: string, turnId: string): Promise<AgentPerformance | undefined> {
		const samples: RequestMeasurement[] = [];
		let cursor = "";
		// Page explicitly: the database adapter bounds each read to 1000 rows.
		while (true) {
			const rows = await this.database.all(
				`SELECT thread_id AS threadId, turn_id AS turnId,
				sample_id AS sampleId, started_at AS startedAt, completed_at AS completedAt,
				first_token_at AS firstTokenAt, output_tokens AS outputTokens
				FROM agent_request_performance WHERE thread_id=? AND turn_id=? AND sample_id>?
				ORDER BY sample_id LIMIT 500`,
				[threadId, turnId, cursor],
			);
			if (!rows.length) break;
			for (const row of rows) {
				const sample = measurement.parse(row);
				samples.push(sample);
				cursor = sample.sampleId;
			}
		}
		return samples.length ? aggregatePerformance(turnId, samples) : undefined;
	}
}
