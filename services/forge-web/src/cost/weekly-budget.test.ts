import type { WeeklyBudget, WeeklyObservation } from "@forge/contracts";
import { expect, test } from "vitest";

import { chartData } from "./weekly-budget.tsx";

const day = 86_400_000;
const origin = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (offset: number) => new Date(origin + offset).toISOString();
const observation = (start: number, offset = 60_000): WeeklyObservation => ({
	bucketId: "codex",
	bucket: "Codex",
	minutes: 10080,
	observedAt: iso(start + offset),
	resetsAt: iso(start + 7 * day),
	usedPercent: 20,
});
const bucket = (observations: WeeklyObservation[]): WeeklyBudget["buckets"][number] => ({
	bucketId: "codex",
	bucket: "Codex",
	observations,
	remainingPercent: 80,
	lastObservedAt: iso(0),
	resetsAt: iso(7 * day),
	fresh: true,
	completedTickets: 0,
	coverageHours: 0,
	consumption: 0,
});

test("derives one reset per recorded cycle and sorts readings", () => {
	const samples = [0, 7, 14, 21]
		.flatMap((days) => [observation(days * day, 120_000), observation(days * day)])
		.reverse();
	const data = chartData(bucket(samples), { from: iso(0), to: iso(28 * day) });
	expect(data.points.filter((point) => point.reset).map((point) => point.time)).toEqual(
		[0, 7, 14, 21].map((d) => origin + d * day),
	);
	expect(data.references).toHaveLength(4);
	expect(data.points.filter((point) => point.remaining === 80).map((point) => point.time)).toEqual(
		samples.map((point) => Date.parse(point.observedAt)).sort((a, b) => a - b),
	);
});

test("preserves exact reset readings, gaps and mid-cycle clipping", () => {
	const samples = [observation(0, 0), observation(0, 900_000), observation(0, 1_800_001)];
	const data = chartData(bucket(samples), { from: iso(0), to: iso(day) });
	expect(data.points.map((point) => point.remaining)).toEqual([100, null, 80, 80, null, 80]);
	const zoom = chartData(bucket(samples), { from: iso(300_000), to: iso(day) });
	expect(zoom.points.some((point) => point.reset)).toBe(false);
	expect(zoom.references[0]).toEqual({
		start: origin + 300_000,
		end: origin + day,
		first: (100 * (7 * day - 300_000)) / (7 * day),
		last: (100 * 6) / 7,
	});
});
