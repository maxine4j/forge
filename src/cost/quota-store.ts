import { weeklyObservationSchema, type WeeklyObservation } from "@forge/contracts";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";

export interface IQuotaStore {
	save(observation: WeeklyObservation): Promise<void>;
	read(since: string): Promise<{ observations: WeeklyObservation[]; completions: string[] }>;
}
export class QuotaStore implements IQuotaStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.database.run(
			"CREATE TABLE IF NOT EXISTS quota_observations (bucketId TEXT NOT NULL, observedAt TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(bucketId,observedAt))",
		);
	}
	async save(observation: WeeklyObservation): Promise<void> {
		const value = weeklyObservationSchema.parse(observation);
		await this.database.run("INSERT OR IGNORE INTO quota_observations VALUES(?,?,?)", [
			value.bucketId,
			value.observedAt,
			JSON.stringify(value),
		]);
	}
	async read(since: string): ReturnType<IQuotaStore["read"]> {
		const observations: WeeklyObservation[] = [],
			completions: string[] = [];
		for (let offset = 0; ; offset += 500) {
			const rows = await this.database.all(
				"SELECT record FROM quota_observations WHERE observedAt>=? ORDER BY observedAt,bucketId LIMIT 500 OFFSET ?",
				[since, offset],
			);
			observations.push(
				...rows.map((row) =>
					weeklyObservationSchema.parse(JSON.parse(z.object({ record: z.string() }).parse(row).record)),
				),
			);
			if (rows.length < 500) break;
		}
		for (let offset = 0; ; offset += 500) {
			const rows = await this.database.all(
				"SELECT completedAt FROM ticket_completions WHERE completedAt>=? ORDER BY completedAt,ticketId LIMIT 500 OFFSET ?",
				[since, offset],
			);
			completions.push(...rows.map((row) => z.object({ completedAt: z.string() }).parse(row).completedAt));
			if (rows.length < 500) break;
		}
		return { observations, completions };
	}
}
