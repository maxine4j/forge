import type { ISleep } from "@forge/backend-infrastructure/sleep";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";

export const exchangeRateSchema = z.object({
	currency: z.string(),
	rate: z.number().positive(),
	date: z.iso.date(),
	fetchedAt: z.iso.datetime(),
});
export type ExchangeRate = z.infer<typeof exchangeRateSchema>;
export interface IExchangeRateClient {
	latest(currency: string): Promise<{ rate: number; date: string }>;
}
export interface IExchangeRateCacheStore {
	get(currency: string): Promise<ExchangeRate | undefined>;
	put(rate: ExchangeRate): Promise<void>;
}
export class FrankfurterClient implements IExchangeRateClient {
	constructor(
		private readonly http: typeof fetch,
		private readonly sleep: ISleep,
	) {}
	async latest(currency: string): Promise<{ rate: number; date: string }> {
		const request = new AbortController(),
			timer = new AbortController();
		void this.sleep(10_000, timer.signal).then(
			() => request.abort(),
			() => {},
		);
		try {
			const response = await this.http(
				`https://api.frankfurter.dev/v2/rate/USD/${encodeURIComponent(currency)}`,
				{
					signal: request.signal,
				},
			);
			if (!response.ok) throw new Error("Exchange rate unavailable");
			return z
				.object({
					base: z.literal("USD"),
					quote: z.literal(currency),
					rate: z.number().positive(),
					date: z.iso.date(),
				})
				.parse(await response.json());
		} finally {
			timer.abort();
		}
	}
}
export class ExchangeRateCacheStore implements IExchangeRateCacheStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.database.run(
			"CREATE TABLE IF NOT EXISTS exchange_rates (currency TEXT PRIMARY KEY, record TEXT NOT NULL)",
		);
	}
	async get(currency: string): Promise<ExchangeRate | undefined> {
		const rows = await this.database.all("SELECT record FROM exchange_rates WHERE currency=?", [currency]);
		return rows.length
			? exchangeRateSchema.parse(JSON.parse(z.object({ record: z.string() }).parse(rows[0]).record))
			: undefined;
	}
	async put(rate: ExchangeRate): Promise<void> {
		await this.database.run(
			"INSERT INTO exchange_rates VALUES (?,?) ON CONFLICT(currency) DO UPDATE SET record=excluded.record",
			[rate.currency, JSON.stringify(exchangeRateSchema.parse(rate))],
		);
	}
}
export class ExchangeRates {
	private readonly pending = new Map<string, Promise<ExchangeRate | undefined>>();
	constructor(
		private readonly client: IExchangeRateClient,
		private readonly store: IExchangeRateCacheStore,
		private readonly now: () => Date,
	) {}
	get(currency: string): Promise<ExchangeRate | undefined> {
		const pending = this.pending.get(currency);
		if (pending) return pending;
		const request = this.load(currency)
			.catch(() => undefined)
			.finally(() => this.pending.delete(currency));
		this.pending.set(currency, request);
		return request;
	}
	private async load(currency: string): Promise<ExchangeRate> {
		const now = this.now();
		if (currency === "USD")
			return { currency, rate: 1, date: now.toISOString().slice(0, 10), fetchedAt: now.toISOString() };
		const cached = await this.store.get(currency);
		if (
			cached
			&& Date.parse(cached.fetchedAt) <= now.getTime()
			&& now.getTime() - Date.parse(cached.fetchedAt) < 4 * 3_600_000
		)
			return cached;
		const latest = await this.client.latest(currency);
		const fetchedAt = this.now().toISOString();
		if (latest.date > fetchedAt.slice(0, 10)) throw new Error("Future exchange publication");
		const value = exchangeRateSchema.parse({ ...latest, currency, fetchedAt });
		await this.store.put(value);
		return value;
	}
}
