import { expect, test } from "vitest";

import { summarizeCosts } from "./cost-summary.ts";
import { allocateQuota, type QuotaSample } from "./quota-attribution.ts";
import type { UsageTurn } from "./types.ts";

const start = "2026-11-12T00:00:00.000Z";
const end = "2026-11-12T00:05:00.000Z";
const turn = (id: string, apiUsd?: number): UsageTurn => ({
	projectId: "repo",
	threadId: "thread",
	turnId: id,
	phase: "implementation",
	ticketId: "TASK-1",
	startedAt: start,
	billing: { localCurrency: "AUD", monthlyPlanLocal: 30, usdToLocal: 1.5 },
	input: 100,
	cached: 0,
	output: 10,
	apiUsd,
});
const sample = (observedAt: string, usedPercent: number, turns: UsageTurn[] = []): QuotaSample => ({
	observedAt,
	weekly: {
		observedAt,
		usedPercent,
		bucketId: "codex",
		bucket: "Codex",
		minutes: 10080,
		resetsAt: "2026-11-15T00:00:00.000Z",
	},
	turns,
});

test("weights incremental API costs including chats and conserves fractional quota consumption", () => {
	const first = turn("ticket", 1);
	const chat: UsageTurn = { ...turn("chat", 3), phase: "chat", ticketId: undefined };
	const before = sample(start, 20, [{ ...first, input: 50, apiUsd: 0.5 }]);
	const after = sample(end, 20.7, [first, chat]);
	const interval = allocateQuota(before, after)!;
	expect(interval.consumption).toBeCloseTo(0.7);
	expect(interval.allocations[0]!.percent).toBeCloseTo(0.1);
	expect(interval.allocations[1]!.percent).toBeCloseTo(0.6);
	expect(interval.allocations[0]!.effectiveUsd).toBeCloseTo(((0.1 / 100) * 30) / 1.5 / 4.33);
	expect(interval.allocations.reduce((sum, entry) => sum + entry.percent, interval.unallocated)).toBe(
		interval.consumption,
	);
	expect(summarizeCosts([first], [interval])).toMatchObject({
		incomplete: { weekly: 1 },
		weeklyUsagePercent: expect.closeTo(0.1),
	});
});

test("missing pricing, no activity, resets, stale gaps, counter decreases and missing selection stay unallocated", () => {
	const before = sample(start, 20);
	for (const after of [
		sample(end, 21, [turn("unknown")]),
		sample(end, 21, [
			{ ...turn("unknown"), input: undefined, cached: undefined, output: undefined },
			turn("known", 1),
		]),
		sample(end, 21),
		sample("2026-11-12T00:16:00.000Z", 21, [turn("a", 1)]),
		{
			...sample(end, 1, [turn("a", 1)]),
			weekly: { ...sample(end, 1).weekly!, resetsAt: "2026-11-22T00:00:00.000Z" },
		},
		sample(end, 19, [turn("a", 1)]),
	]) {
		const interval = allocateQuota(before, after)!;
		expect(interval.allocations).toEqual([]);
		expect(interval.unallocated).toBe(interval.consumption);
	}
	expect(allocateQuota(before, { ...sample(end, 21), weekly: undefined })).toBeUndefined();
	expect(allocateQuota({ ...before, weekly: undefined }, sample(end, 21, [turn("a", 1)]))).toMatchObject({
		unallocated: 0,
		allocations: [],
	});
});

test("sums historical conversions per record, groups currencies, and preserves unavailable inputs", () => {
	const a = turn("a", 1),
		b = { ...turn("b", 2), billing: { localCurrency: "AUD", monthlyPlanLocal: 60, usdToLocal: 2 } },
		c = { ...turn("c", 3), billing: { localCurrency: "EUR", monthlyPlanLocal: 30, usdToLocal: 0.9 } };
	const interval = allocateQuota(sample(start, 0), sample(end, 6, [a, b, c]))!;
	const result = summarizeCosts([a, b, c], [interval]);
	expect(result.apiUsd).toBe(6);
	expect(result.localCurrencies).toMatchObject([
		{ currency: "AUD", api: 5.5 },
		{ currency: "EUR", api: 2.7 },
	]);
	expect(result.effectiveUsd).toBeCloseTo(((0.01 * 30) / 1.5 + (0.02 * 60) / 2 + (0.03 * 30) / 0.9) / 4.33);
	expect(result.incomplete).toEqual({ api: 0, weekly: 0, effective: 0, conversion: 0, tokens: 0 });
	const unavailable = { ...a, billing: { localCurrency: "AUD", monthlyPlanLocal: 30 } };
	const unconverted = allocateQuota(sample(start, 0), sample(end, 1, [unavailable]))!;
	expect(summarizeCosts([unavailable], [unconverted])).toMatchObject({
		apiUsd: 1,
		weeklyUsagePercent: 1,
		incomplete: { conversion: 1, effective: 1 },
	});
	expect(summarizeCosts([a], [interval, { ...interval, bucketId: "other" }])).toMatchObject({
		weeklyBuckets: [{ bucketId: "codex" }, { bucketId: "other" }],
	});
});
