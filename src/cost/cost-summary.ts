import type { CostSummary } from "@forge/contracts";

import { turnKey, type QuotaInterval } from "./quota-attribution.ts";
import type { UsageTurn } from "./types.ts";

export function summarizeCosts(turns: UsageTurn[], intervals: QuotaInterval[]): CostSummary {
	const summary: CostSummary = {
		input: 0,
		cached: 0,
		output: 0,
		turns: turns.length,
		incomplete: { api: 0, weekly: 0, effective: 0, conversion: 0, tokens: 0 },
		weeklyBuckets: [],
		localCurrencies: [],
	};
	if (!turns.length) return { ...summary, apiUsd: 0, weeklyUsagePercent: 0, effectiveUsd: 0 };
	const allocations = new Map<
		string,
		{ bucketId: string; percent: number; effectiveUsd?: number; apiUsd: number }[]
	>();
	for (const interval of intervals)
		for (const allocation of interval.allocations) {
			const key = turnKey(allocation);
			const entries = allocations.get(key) ?? [];
			entries.push({ ...allocation, bucketId: interval.bucketId });
			allocations.set(key, entries);
		}
	for (const turn of turns) {
		summary.input += turn.input ?? 0;
		summary.cached += turn.cached ?? 0;
		summary.output += turn.output ?? 0;
		if (turn.input === undefined || turn.cached === undefined || turn.output === undefined)
			summary.incomplete.tokens++;
		const local = summary.localCurrencies.find((value) => value.currency === turn.billing.localCurrency) ?? {
			currency: turn.billing.localCurrency,
			incomplete: 0,
			api: undefined,
			effective: undefined,
		};
		if (!summary.localCurrencies.includes(local)) summary.localCurrencies.push(local);
		const entries = allocations.get(turnKey(turn)) ?? [];
		const covered = entries.reduce((sum, entry) => sum + entry.apiUsd, 0);
		const weeklyIncomplete =
			!entries.length || turn.apiUsd === undefined || Math.abs(covered - turn.apiUsd) > 1e-10;
		if (weeklyIncomplete) summary.incomplete.weekly++;
		if (weeklyIncomplete || entries.some((entry) => entry.effectiveUsd === undefined))
			summary.incomplete.effective++;
		if (turn.apiUsd === undefined) summary.incomplete.api++;
		else summary.apiUsd = (summary.apiUsd ?? 0) + turn.apiUsd;
		if (turn.billing.usdToLocal === undefined) {
			summary.incomplete.conversion++;
			local.incomplete++;
		} else if (turn.apiUsd !== undefined) local.api = (local.api ?? 0) + turn.apiUsd * turn.billing.usdToLocal;
		for (const entry of entries) {
			const bucket = summary.weeklyBuckets.find((value) => value.bucketId === entry.bucketId) ?? {
				bucketId: entry.bucketId,
				percent: 0,
			};
			if (!summary.weeklyBuckets.includes(bucket)) summary.weeklyBuckets.push(bucket);
			bucket.percent += entry.percent;
			if (entry.effectiveUsd !== undefined) {
				summary.effectiveUsd = (summary.effectiveUsd ?? 0) + entry.effectiveUsd;
				if (turn.billing.usdToLocal !== undefined)
					local.effective = (local.effective ?? 0) + entry.effectiveUsd * turn.billing.usdToLocal;
			}
		}
	}
	if (summary.weeklyBuckets.length === 1) summary.weeklyUsagePercent = summary.weeklyBuckets[0]!.percent;
	if (summary.weeklyBuckets.length > 1) summary.incomplete.weekly = turns.length;
	return summary;
}
