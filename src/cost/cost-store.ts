import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import { apiCostUsd } from "./api-pricing.ts";
import type { UsageTurn } from "./types.ts";

const recordSchema = z
	.object({
		projectId: z.string(),
		threadId: z.string(),
		turnId: z.string(),
		startedAt: z.iso.datetime(),
		durationMs: z
			.int()
			.nonnegative()
			.nullish()
			.transform((value) => value ?? undefined),
		billing: z.object({
			localCurrency: z.string(),
			monthlyPlanLocal: z.number().nonnegative(),
			usdToLocal: z.number().positive().optional(),
			rateDate: z.iso.date().optional(),
			fetchedAt: z.iso.datetime().optional(),
			rates: z
				.object({
					input: z.number().nonnegative(),
					cached: z.number().nonnegative(),
					output: z.number().nonnegative(),
				})
				.optional(),
		}),
		pricingUnavailable: z.boolean().optional(),
		apiUsd: z
			.number()
			.nonnegative()
			.nullish()
			.transform((value) => value ?? undefined),
		model: z.string().optional(),
		input: z
			.int()
			.nonnegative()
			.nullish()
			.transform((value) => value ?? undefined),
		cached: z
			.int()
			.nonnegative()
			.nullish()
			.transform((value) => value ?? undefined),
		output: z
			.int()
			.nonnegative()
			.nullish()
			.transform((value) => value ?? undefined),
	})
	.and(
		z.discriminatedUnion("phase", [
			z.object({ phase: z.literal("chat"), ticketId: z.undefined().optional() }),
			z.object({ phase: z.enum(["planning", "implementation", "review", "rebase"]), ticketId: z.string() }),
		]),
	);

export interface ICostHistory {
	read(ticketId?: string): Promise<{ since: string; turns: UsageTurn[] }>;
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
				sql: "CREATE TABLE IF NOT EXISTS codex_usage (projectId TEXT NOT NULL, threadId TEXT NOT NULL, turnId TEXT NOT NULL, ticketId TEXT, record TEXT NOT NULL, PRIMARY KEY(threadId, turnId))",
			},
			{ sql: "CREATE INDEX IF NOT EXISTS codex_usage_ticket ON codex_usage(ticketId)" },
		]);
	}

	async read(ticketId?: string): Promise<{ since: string; turns: UsageTurn[] }> {
		const metadata = await this.database.all("SELECT since FROM cost_tracking WHERE id=1");
		const { since } = z.object({ since: z.iso.datetime() }).parse(metadata.at(0));
		const turns: UsageTurn[] = [];
		for (let offset = 0; ; offset += 500) {
			const rows = await this.database.all(
				ticketId
					? "SELECT record FROM codex_usage WHERE ticketId=? ORDER BY rowid LIMIT 500 OFFSET ?"
					: "SELECT record FROM codex_usage ORDER BY rowid LIMIT 500 OFFSET ?",
				ticketId ? [ticketId, offset] : [offset],
			);
			for (const row of rows)
				turns.push(recordSchema.parse(JSON.parse(z.object({ record: z.string() }).parse(row).record)));
			if (rows.length < 500) return { since, turns };
		}
	}

	async save(turn: UsageTurn): Promise<void> {
		const record = recordSchema.parse(turn);
		record.apiUsd =
			record.pricingUnavailable
			|| record.input === undefined
			|| record.cached === undefined
			|| record.output === undefined
				? undefined
				: apiCostUsd(record.billing.rates, {
						input: record.input,
						cached: record.cached ?? 0,
						output: record.output ?? 0,
					});
		await this.database.run(
			// Keep dispatch metadata immutable even when writers overlap or settings change.
			`INSERT INTO codex_usage(projectId, threadId, turnId, ticketId, record) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(threadId, turnId) DO UPDATE SET record=json_set(codex_usage.record,
     '$.input', json_extract(excluded.record, '$.input'),
     '$.cached', json_extract(excluded.record, '$.cached'),
     '$.output', json_extract(excluded.record, '$.output'),
     '$.durationMs', COALESCE(json_extract(excluded.record, '$.durationMs'), json_extract(codex_usage.record, '$.durationMs')),
     '$.pricingUnavailable', json(CASE WHEN json_extract(excluded.record, '$.pricingUnavailable') OR json_extract(codex_usage.record, '$.pricingUnavailable') THEN 'true' ELSE 'false' END),
     '$.apiUsd', CASE WHEN json_extract(codex_usage.record, '$.billing.rates') IS NULL
       OR json_extract(excluded.record, '$.input') IS NULL
       OR json_extract(excluded.record, '$.cached') IS NULL
       OR json_extract(excluded.record, '$.output') IS NULL
       OR json_extract(excluded.record, '$.pricingUnavailable')
       OR json_extract(codex_usage.record, '$.pricingUnavailable') THEN NULL
      ELSE ((json_extract(excluded.record, '$.input') - json_extract(excluded.record, '$.cached')) * json_extract(codex_usage.record, '$.billing.rates.input')
       + json_extract(excluded.record, '$.cached') * json_extract(codex_usage.record, '$.billing.rates.cached')
       + json_extract(excluded.record, '$.output') * json_extract(codex_usage.record, '$.billing.rates.output')) / 1000000.0 END)
    WHERE projectId=excluded.projectId
     AND COALESCE(json_extract(excluded.record, '$.input'),0) >= COALESCE(json_extract(codex_usage.record, '$.input'),0)
     AND COALESCE(json_extract(excluded.record, '$.cached'),0) >= COALESCE(json_extract(codex_usage.record, '$.cached'),0)
     AND COALESCE(json_extract(excluded.record, '$.output'),0) >= COALESCE(json_extract(codex_usage.record, '$.output'),0)`,
			[record.projectId, record.threadId, record.turnId, record.ticketId ?? null, JSON.stringify(record)],
		);
	}
}
