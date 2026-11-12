import type { WeeklyObservation } from "@forge/contracts";

import type { UsageTurn } from "./types.ts";
import { quotaGap } from "./weekly-budget.ts";

export interface QuotaSample {
	observedAt: string;
	weekly?: WeeklyObservation;
	observations?: WeeklyObservation[];
	turns: UsageTurn[];
}
export interface QuotaAllocation {
	threadId: string;
	turnId: string;
	percent: number;
	apiUsd: number;
	effectiveUsd?: number;
}
export interface QuotaInterval {
	start: string;
	end: string;
	bucketId: string;
	resetsAt: string;
	consumption: number;
	unallocated: number;
	allocations: QuotaAllocation[];
}
export const turnKey = (turn: { threadId: string; turnId: string }) => JSON.stringify([turn.threadId, turn.turnId]);

export function allocateQuota(previous: QuotaSample, current: QuotaSample): QuotaInterval | undefined {
	const a = previous.weekly,
		b = current.weekly;
	if (!b) return undefined;
	const sameCycle = a?.bucketId === b.bucketId && a.resetsAt === b.resetsAt;
	const consumption = Math.max(
		0,
		sameCycle ? b.usedPercent - a.usedPercent : a?.bucketId === b.bucketId ? b.usedPercent : 0,
	);
	const interval: QuotaInterval = {
		start: previous.observedAt,
		end: current.observedAt,
		bucketId: b.bucketId,
		resetsAt: b.resetsAt,
		consumption,
		unallocated: consumption,
		allocations: [],
	};
	const gap = Date.parse(current.observedAt) - Date.parse(previous.observedAt);
	if (
		!a
		|| !sameCycle
		|| gap <= 0
		|| gap > quotaGap
		|| Date.parse(b.observedAt) >= Date.parse(b.resetsAt)
		|| b.usedPercent < a.usedPercent
	)
		return interval;
	const old = new Map(previous.turns.map((turn) => [turnKey(turn), turn]));
	const weights: { turn: UsageTurn; weight: number }[] = [];
	for (const turn of current.turns) {
		const before = old.get(turnKey(turn));
		const changed =
			!before
			|| (turn.input ?? 0) !== (before?.input ?? 0)
			|| (turn.cached ?? 0) !== (before?.cached ?? 0)
			|| (turn.output ?? 0) !== (before?.output ?? 0);
		if (!changed) continue;
		if (turn.apiUsd === undefined || (before && before.input !== undefined && before.apiUsd === undefined))
			return interval;
		const weight = turn.apiUsd - (before?.apiUsd ?? 0);
		if (weight < 0) return interval;
		if (weight > 0) weights.push({ turn, weight });
	}
	const total = weights.reduce((sum, entry) => sum + entry.weight, 0);
	if (!total) return interval;
	let remaining = consumption;
	interval.allocations = weights.map(({ turn, weight }, index) => {
		const percent = index === weights.length - 1 ? remaining : (consumption * weight) / total;
		remaining -= percent;
		const { usdToLocal, monthlyPlanLocal } = turn.billing;
		return {
			threadId: turn.threadId,
			turnId: turn.turnId,
			percent,
			apiUsd: weight,
			effectiveUsd:
				usdToLocal === undefined ? undefined : ((percent / 100) * monthlyPlanLocal) / usdToLocal / 4.33,
		};
	});
	interval.unallocated = 0;
	return interval;
}
