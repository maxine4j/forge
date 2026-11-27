import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import { expect, test, vi } from "vitest";

import { SqliteDatabase } from "../database/sqlite-database.ts";
import { ExchangeRateCacheStore, ExchangeRates, FrankfurterClient, type ExchangeRate } from "./exchange-rate.ts";

const idle = () => new Promise<void>(() => {});

test("uses the documented pair endpoint, coalesces refresh, retains publication date, expires after four hours", async () => {
	let now = new Date("2026-11-12T00:00:00.000Z");
	const http = vi
		.fn<typeof fetch>()
		.mockResolvedValue(new Response(JSON.stringify({ base: "USD", quote: "AUD", date: "2026-11-10", rate: 1.5 })));
	const client = new FrankfurterClient(async (...args) => (await http(...args)).clone(), idle);
	let cached: ExchangeRate | undefined;
	const store = {
		get: async () => cached,
		put: async (value: ExchangeRate) => {
			cached = value;
		},
	};
	const rates = new ExchangeRates(client, store, () => now);
	const values = await Promise.all(Array.from({ length: 10 }, () => rates.get("AUD")));
	expect(http).toHaveBeenCalledTimes(1);
	expect(http).toHaveBeenCalledWith("https://api.frankfurter.dev/v2/rate/USD/AUD", expect.anything());
	expect(values[0]).toEqual({ currency: "AUD", rate: 1.5, date: "2026-11-10", fetchedAt: now.toISOString() });
	now = new Date("2026-11-12T03:59:59.999Z");
	await rates.get("AUD");
	expect(http).toHaveBeenCalledTimes(1);
	// A new service instance still uses the persisted fetch time.
	now = new Date("2026-11-12T04:00:00.000Z");
	await new ExchangeRates(client, store, () => now).get("AUD");
	expect(http).toHaveBeenCalledTimes(2);
	expect(cached?.date).toBe("2026-11-10");
	expect(cached?.fetchedAt).toBe(now.toISOString());
	expect(await rates.get("USD")).toMatchObject({ currency: "USD", rate: 1 });
	expect(http).toHaveBeenCalledTimes(2);
});

test("expired cache is never used on outages or invalid provider responses", async () => {
	const cached: ExchangeRate = {
		currency: "AUD",
		rate: 1.5,
		date: "2026-11-10",
		fetchedAt: "2026-11-11T00:00:00.000Z",
	};
	const put = vi.fn();
	for (const body of [
		{ rate: 0 },
		{ base: "AUD", quote: "USD", rate: 1.5, date: "2026-11-10" },
		{ base: "USD", quote: "AUD", rate: -1, date: "2026-11-10" },
		{ base: "USD", quote: "AUD", rate: 1, date: "2026-11-13" },
		null,
	]) {
		const client = new FrankfurterClient(
			vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body))),
			idle,
		);
		const rates = new ExchangeRates(
			client,
			{ get: async () => cached, put },
			() => new Date("2026-11-12T00:00:00Z"),
		);
		expect(await rates.get("AUD")).toBeUndefined();
	}
	const rates = new ExchangeRates(
		new FrankfurterClient(vi.fn<typeof fetch>().mockRejectedValue(new Error("offline")), idle),
		{ get: async () => cached, put },
		() => new Date("2026-11-12T00:00:00Z"),
	);
	expect(await rates.get("AUD")).toBeUndefined();
	expect(put).not.toHaveBeenCalled();
});

test("SQLite cache survives database restart", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-exchange-"));
	const path = join(directory, "db.sqlite");
	let db = new SqliteDatabase(path);
	await db.initialize();
	try {
		const store = new ExchangeRateCacheStore(db);
		await store.initialize();
		const now = () => new Date("2026-11-12T00:00:00Z");
		await new ExchangeRates({ latest: async () => ({ rate: 1.5, date: "2026-11-10" }) }, store, now).get("AUD");
		await db.close();
		db = new SqliteDatabase(path);
		await db.initialize();
		const latest = vi.fn();
		expect(await new ExchangeRates({ latest }, new ExchangeRateCacheStore(db), now).get("AUD")).toMatchObject({
			rate: 1.5,
			date: "2026-11-10",
		});
		expect(latest).not.toHaveBeenCalled();
	} finally {
		await db.close();
		await rm(directory, { recursive: true, force: true });
	}
});

test("bounds provider requests with the injected timer and rejects HTTP failures", async () => {
	let expire!: () => void;
	const client = new FrankfurterClient(
		(_url, options) =>
			new Promise((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(new Error("timed out")), { once: true });
			}),
		() =>
			new Promise<void>((resolve) => {
				expire = resolve;
			}),
	);
	const request = client.latest("AUD");
	expire();
	await expect(request).rejects.toThrow("timed out");
	await expect(
		new FrankfurterClient(async () => new Response("offline", { status: 503 }), idle).latest("AUD"),
	).rejects.toThrow("Exchange rate unavailable");
});
