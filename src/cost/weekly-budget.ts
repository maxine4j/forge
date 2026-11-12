import type { WeeklyBudget, WeeklyObservation } from "@forge/contracts";

const day = 86_400_000;
export const quotaGap = 15 * 60_000;

/** Intervals are open on the left so a completion is counted only once. */
export function weeklyBudget(observations: WeeklyObservation[], completions: string[], now: Date): WeeklyBudget {
	const cutoff = now.getTime() - 28 * day;
	const groups = new Map<string, WeeklyObservation[]>();
	for (const observation of observations) {
		if (Date.parse(observation.observedAt) < cutoff || Date.parse(observation.observedAt) > now.getTime()) continue;
		const group = groups.get(observation.bucketId) ?? [];
		group.push(observation);
		groups.set(observation.bucketId, group);
	}
	const buckets: WeeklyBudget["buckets"] = [];
	for (const [bucketId, series] of groups) {
		series.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
		const latest = series.at(-1)!;
		let coverage = 0,
			consumption = 0,
			completedTickets = 0;
		let periodStart: string | undefined, periodEnd: string | undefined;
		for (let index = 1; index < series.length; index++) {
			const previous = series[index - 1]!;
			const current = series[index]!;
			const start = Date.parse(previous.observedAt),
				end = Date.parse(current.observedAt);
			if (
				end <= start
				|| end - start > quotaGap
				|| previous.resetsAt !== current.resetsAt
				|| end >= Date.parse(previous.resetsAt)
				|| current.usedPercent < previous.usedPercent
			)
				continue;
			coverage += end - start;
			consumption += current.usedPercent - previous.usedPercent;
			completedTickets += completions.filter(
				(value) => Date.parse(value) > start && Date.parse(value) <= end,
			).length;
			periodStart ??= previous.observedAt;
			periodEnd = current.observedAt;
		}
		const remainingPercent = Math.max(0, 100 - latest.usedPercent);
		const unavailable =
			Date.parse(latest.resetsAt) <= now.getTime()
				? "reset-passed"
				: now.getTime() - Date.parse(latest.observedAt) > quotaGap
					? "stale"
					: remainingPercent > 0 && (coverage < day || completedTickets < 3 || consumption <= 0)
						? "learning"
						: undefined;
		buckets.push({
			bucketId,
			bucket: latest.bucket,
			observations: series,
			remainingPercent,
			lastObservedAt: latest.observedAt,
			resetsAt: latest.resetsAt,
			fresh: unavailable !== "stale" && unavailable !== "reset-passed",
			unavailable,
			additionalTickets: unavailable
				? undefined
				: remainingPercent === 0
					? 0
					: Math.floor((remainingPercent * completedTickets) / consumption),
			completedTickets,
			coverageHours: coverage / 3_600_000,
			consumption,
			periodStart,
			periodEnd,
		});
	}
	buckets.sort((a, b) => a.remainingPercent - b.remainingPercent || a.bucketId.localeCompare(b.bucketId));
	return {
		defaultBucketId:
			buckets.length === 1
				? buckets[0]?.bucketId
				: buckets.find((bucket) => bucket.bucketId === "codex")?.bucketId,
		buckets,
	};
}
