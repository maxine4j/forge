import type { CostSummary, TicketCost } from "@forge/contracts";

export function costFixture(
	tokens: { input: number; cached: number; output: number; turns: number },
	apiUsd = 0,
	weeklyUsagePercent = 0,
	effectiveUsd = 0,
): CostSummary {
	return {
		...tokens,
		apiUsd,
		weeklyUsagePercent,
		effectiveUsd,
		incomplete: { api: 0, weekly: 0, effective: 0, conversion: 0, tokens: 0 },
		weeklyBuckets: [{ bucketId: "codex", percent: weeklyUsagePercent }],
		localCurrencies: [{ currency: "AUD", api: apiUsd * 1.44, effective: effectiveUsd * 1.44, incomplete: 0 }],
	};
}
export const phaseFixtures = (summary: CostSummary): TicketCost["phases"] => [
	{
		phase: "planning",
		...costFixture(
			{
				input: summary.input / 2,
				cached: summary.cached / 2,
				output: summary.output / 2,
				turns: Math.floor(summary.turns / 2),
			},
			(summary.apiUsd ?? 0) / 2,
			(summary.weeklyUsagePercent ?? 0) / 2,
			(summary.effectiveUsd ?? 0) / 2,
		),
	},
	{
		phase: "implementation",
		...costFixture(
			{
				input: summary.input / 2,
				cached: summary.cached / 2,
				output: summary.output / 2,
				turns: Math.ceil(summary.turns / 2),
			},
			(summary.apiUsd ?? 0) / 2,
			(summary.weeklyUsagePercent ?? 0) / 2,
			(summary.effectiveUsd ?? 0) / 2,
		),
	},
];
