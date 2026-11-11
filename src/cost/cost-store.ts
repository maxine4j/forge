import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import type { UsageTurn } from "./types.ts";

const recordSchema = z
	.object({
		projectId: z.string(),
		threadId: z.string(),
		turnId: z.string(),
		startedAt: z.iso.datetime(),
		durationMs: z.int().nonnegative().optional(),
		monthlyAud: z.number().nonnegative(),
		model: z.string().optional(),
		input: z.int().nonnegative().optional(),
		cached: z.int().nonnegative().optional(),
		output: z.int().nonnegative().optional(),
	})
	.and(
		z.discriminatedUnion("phase", [
			z.object({ phase: z.literal("chat"), ticketId: z.undefined().optional() }),
			z.object({ phase: z.enum(["planning", "implementation", "review", "rebase"]), ticketId: z.string() }),
		]),
	);

export interface ICostHistory {
	read(projectId: string): Promise<{ since: string; turns: UsageTurn[] }>;
}

export interface ICostStore extends ICostHistory {
	save(turn: UsageTurn): Promise<void>;
}

export class CostStore implements ICostStore {
	constructor(private readonly database: IDatabase) {}

	async initialize(since: string): Promise<void> {
		await this.database.transaction([
			{
				sql: "CREATE TABLE IF NOT EXISTS cost_tracking (id INTEGER PRIMARY KEY CHECK (id = 1), since TEXT NOT NULL)",
			},
			{ sql: "INSERT OR IGNORE INTO cost_tracking(id, since) VALUES (1, ?)", parameters: [since] },
			{
				sql: "CREATE TABLE IF NOT EXISTS codex_usage (projectId TEXT NOT NULL, threadId TEXT NOT NULL, turnId TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(threadId, turnId))",
			},
			{ sql: "CREATE INDEX IF NOT EXISTS codex_usage_project ON codex_usage(projectId)" },
		]);
	}

	async read(projectId: string): Promise<{ since: string; turns: UsageTurn[] }> {
		const metadata = await this.database.all("SELECT since FROM cost_tracking WHERE id=1");
		const { since } = z.object({ since: z.iso.datetime() }).parse(metadata.at(0));
		const turns: UsageTurn[] = [];
		for (let offset = 0; ; offset += 500) {
			const rows = await this.database.all(
				"SELECT record FROM codex_usage WHERE projectId=? ORDER BY rowid LIMIT 500 OFFSET ?",
				[projectId, offset],
			);
			for (const row of rows)
				turns.push(recordSchema.parse(JSON.parse(z.object({ record: z.string() }).parse(row).record)));
			if (rows.length < 500) return { since, turns };
		}
	}

	async save(turn: UsageTurn): Promise<void> {
		const record = recordSchema.parse(turn);
		await this.database.run(
			"INSERT INTO codex_usage(projectId, threadId, turnId, record) VALUES(?, ?, ?, ?) ON CONFLICT(threadId, turnId) DO UPDATE SET record=excluded.record WHERE projectId=excluded.projectId",
			[record.projectId, record.threadId, record.turnId, JSON.stringify(record)],
		);
	}
}
