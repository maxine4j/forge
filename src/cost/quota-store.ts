import { weeklyObservationSchema, type WeeklyObservation } from "@forge/contracts";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import type { ICostHistory } from "./cost-store.ts";
import { allocateQuota, type QuotaSample, type QuotaInterval } from "./quota-attribution.ts";

export interface IQuotaStore {
	save(observation: WeeklyObservation): Promise<void>;
	read(since: string): Promise<{ observations: WeeklyObservation[]; completions: string[] }>;
	capture?(observations: WeeklyObservation[], observedAt: string, selectable?: boolean): Promise<void>;
	intervals?(): Promise<QuotaInterval[]>;
}
export class QuotaStore implements IQuotaStore {
	private pending: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly database: IDatabase,
		private readonly costs?: ICostHistory,
	) {}
	async initialize(): Promise<void> {
		await this.database.run(
			"CREATE TABLE IF NOT EXISTS quota_baselines (bucketId TEXT PRIMARY KEY, observedAt TEXT NOT NULL, record TEXT NOT NULL)",
		);
		await this.database.run(
			"CREATE TABLE IF NOT EXISTS quota_samples (observedAt TEXT PRIMARY KEY, record TEXT NOT NULL, allocation TEXT)",
		);
		await this.database.run(
			"CREATE TABLE IF NOT EXISTS quota_observations (bucketId TEXT NOT NULL, observedAt TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(bucketId,observedAt))",
		);
	}
	capture(observations: WeeklyObservation[], observedAt: string, selectable = true): Promise<void> {
		const work = this.pending.then(async () => {
			if (
				(await this.database.all("SELECT observedAt FROM quota_samples WHERE observedAt=?", [observedAt]))
					.length
			)
				return;
			const stable = observations.filter((value) => value.bucketId === "codex");
			const selected = !selectable
				? undefined
				: observations.length === 1
					? observations[0]
					: stable.length === 1
						? stable[0]
						: undefined;
			const current: QuotaSample = {
				observedAt,
				observations,
				weekly: selected,
				turns: this.costs ? (await this.costs.read()).turns : [],
			};
			const rows = await this.database.all(
				"SELECT record FROM quota_samples WHERE observedAt < ? ORDER BY observedAt DESC LIMIT 1",
				[observedAt],
			);
			const previous = rows.length
				? (JSON.parse(z.object({ record: z.string() }).parse(rows[0]).record) as QuotaSample)
				: undefined;
			const intervals: QuotaInterval[] = [];
			for (const observation of observations) {
				const priorRows = await this.database.all(
					"SELECT record FROM quota_baselines WHERE bucketId=? AND observedAt < ?",
					[observation.bucketId, observedAt],
				);
				if (!priorRows.length) continue;
				const prior = JSON.parse(z.object({ record: z.string() }).parse(priorRows[0]).record) as QuotaSample;
				const baseline = prior.observations?.find((value) => value.bucketId === observation.bucketId);
				const interval = allocateQuota({ ...prior, weekly: baseline }, { ...current, weekly: observation });
				if (!interval) continue;
				if (
					selected?.bucketId !== observation.bucketId
					|| previous?.weekly?.bucketId !== observation.bucketId
					|| prior.observedAt !== previous?.observedAt
				) {
					interval.allocations = [];
					interval.unallocated = interval.consumption;
				}
				intervals.push(interval);
			}
			await this.database.transaction([
				...observations.map((observation) => ({
					sql: "INSERT OR IGNORE INTO quota_observations VALUES(?,?,?)",
					parameters: [
						observation.bucketId,
						observation.observedAt,
						JSON.stringify(weeklyObservationSchema.parse(observation)),
					],
				})),
				...observations.map((observation) => ({
					sql: "INSERT INTO quota_baselines VALUES(?,?,?) ON CONFLICT(bucketId) DO UPDATE SET observedAt=excluded.observedAt, record=excluded.record WHERE observedAt < excluded.observedAt",
					parameters: [observation.bucketId, observedAt, JSON.stringify(current)],
				})),
				{
					sql: "INSERT OR IGNORE INTO quota_samples VALUES(?,?,?)",
					parameters: [observedAt, JSON.stringify({ ...current, turns: [] }), JSON.stringify(intervals)],
				},
			]);
		});
		this.pending = work.catch(() => {});
		return work;
	}
	async intervals(): Promise<QuotaInterval[]> {
		const result: QuotaInterval[] = [];
		for (let offset = 0; ; offset += 500) {
			const rows = await this.database.all(
				"SELECT allocation FROM quota_samples WHERE allocation IS NOT NULL ORDER BY observedAt LIMIT 500 OFFSET ?",
				[offset],
			);
			result.push(
				...rows.flatMap(
					(row) => JSON.parse(z.object({ allocation: z.string() }).parse(row).allocation) as QuotaInterval[],
				),
			);
			if (rows.length < 500) return result;
		}
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
