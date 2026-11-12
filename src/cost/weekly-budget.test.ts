import type { WeeklyObservation } from "@forge/contracts";
import { expect, test } from "vitest";

import { weeklyBudget } from "./weekly-budget.ts";

const start = Date.parse("2026-11-10T00:00:00.000Z");
const iso = (offset: number) => new Date(start + offset).toISOString();
const series = (): WeeklyObservation[] =>
	Array.from({ length: 289 }, (_, index) => ({
		bucketId: "codex",
		bucket: "Codex",
		minutes: 10080,
		observedAt: iso(index * 300_000),
		usedPercent: 45 + (index * 15) / 288,
		resetsAt: iso(7 * 86_400_000),
	}));
const completions = [iso(300_000), iso(600_000), iso(900_000)];
const calculate = (samples = series(), done = completions, now = new Date(iso(86_400_000))) =>
	weeklyBudget(samples, done, now).buckets[0]!;

test("uses account-wide completions, coverage and positive consumption, rounding down", () => {
	expect(calculate()).toMatchObject({
		remainingPercent: 40,
		completedTickets: 3,
		coverageHours: 24,
		consumption: 15,
		additionalTickets: 8,
	});
	expect(calculate(series(), completions.slice(0, 2)).unavailable).toBe("learning");
	expect(calculate(series().slice(1)).unavailable).toBe("learning");
	expect(calculate(series().map((sample) => ({ ...sample, usedPercent: 60 }))).unavailable).toBe("learning");
	const samples = series();
	samples.at(-1)!.usedPercent = 61;
	expect(calculate(samples).additionalTickets).toBe(7);
});
test("excludes gaps, reset boundaries and counter decreases", () => {
	for (const kind of ["gap", "reset", "decrease"]) {
		const samples = series();
		if (kind === "gap") samples.splice(1, 3);
		if (kind === "reset") samples[1]!.resetsAt = iso(8 * 86_400_000);
		if (kind === "decrease") samples[1]!.usedPercent = 44;
		expect(calculate(samples).coverageHours).toBeLessThan(24);
		expect(calculate(samples).unavailable).toBe("learning");
	}
});
test("suppresses stale and expired estimates, but exhausted fresh allowance is zero", () => {
	expect(calculate(undefined, undefined, new Date(iso(86_400_000 + 900_001))).unavailable).toBe("stale");
	expect(calculate(undefined, undefined, new Date(iso(7 * 86_400_000))).unavailable).toBe("reset-passed");
	expect(calculate([{ ...series()[0]!, observedAt: iso(86_400_000), usedPercent: 100 }], []).additionalTickets).toBe(
		0,
	);
});
test("selects lowest remaining bucket, keeps reset cycles and drops history outside 28 days", () => {
	const samples = series();
	const result = weeklyBudget(
		[...samples, { ...samples.at(-1)!, bucketId: "other", bucket: "Other", usedPercent: 80 }],
		completions,
		new Date(iso(86_400_000)),
	);
	expect(result.defaultBucketId).toBe("other");
	expect(weeklyBudget(samples, [], new Date(iso(30 * 86_400_000))).buckets).toEqual([]);
});
