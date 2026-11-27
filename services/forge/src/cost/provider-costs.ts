import type { Costs } from "@forge/contracts";

import { apiCostUsd } from "./api-pricing.ts";
import type { QuotaInterval } from "./quota-attribution.ts";
import type { UsageTurn } from "./types.ts";

export const summarizeProviderCosts = (
	turns: UsageTurn[],
	weeklyPercentPerUsd?: number,
): Costs["providerTotals"]["ollama"] => {
	const summary: Costs["providerTotals"]["ollama"] = {
		input: 0,
		cached: 0,
		output: 0,
		turns: turns.length,
		apiAud: turns.length ? undefined : 0,
		incomplete: 0,
		incompleteTokens: 0,
		weeklySavedPercent: turns.length ? undefined : 0,
		incompleteWeekly: 0,
	};
	for (const turn of turns) {
		const { input, cached, output } = turn;
		summary.input += input ?? 0;
		summary.cached += cached ?? 0;
		summary.output += output ?? 0;
		const counts =
			input === undefined || cached === undefined || output === undefined ? undefined : { input, cached, output };
		if (!counts) summary.incompleteTokens++;
		const ollama = turn.providerKind === "ollama";
		const usd = ollama ? counts && apiCostUsd(turn.billing.benchmark?.rates, counts) : turn.apiUsd;
		const rate = turn.billing.localCurrency === "AUD" ? turn.billing.usdToLocal : turn.billing.usdToAud;
		if (usd === undefined || rate === undefined) summary.incomplete++;
		else summary.apiAud = (summary.apiAud ?? 0) + usd * rate;
		if (ollama) {
			if (usd === undefined || (usd > 0 && weeklyPercentPerUsd === undefined)) summary.incompleteWeekly++;
			else summary.weeklySavedPercent = (summary.weeklySavedPercent ?? 0) + usd * (weeklyPercentPerUsd ?? 0);
		}
	}
	return summary;
};

export const openaiProviderTotals = (turns: UsageTurn[]): Costs["providerTotals"]["openai"] => {
	const { input, cached, output, turns: count, apiAud, incomplete, incompleteTokens } = summarizeProviderCosts(turns);
	return { input, cached, output, turns: count, apiAud, incomplete, incompleteTokens };
};

export const observedWeeklyPercentPerUsd = (intervals: QuotaInterval[]): number | undefined => {
	const buckets = new Set<string>();
	let percent = 0;
	let usd = 0;
	for (const interval of intervals) {
		for (const allocation of interval.allocations) {
			buckets.add(interval.bucketId);
			percent += allocation.percent;
			usd += allocation.apiUsd;
		}
	}
	return buckets.size === 1 && percent > 0 && usd > 0 ? percent / usd : undefined;
};
