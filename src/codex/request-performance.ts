import type { AgentPerformance } from "@forge/contracts/agents";

export interface RequestMeasurement {
	threadId: string;
	turnId: string;
	sampleId: string;
	startedAt: number;
	completedAt?: number;
	firstTokenAt?: number;
	outputTokens?: number;
}

/** Only completed, usable model requests enter either denominator. No wall clock is used. */
export const aggregatePerformance = (turnId: string, samples: RequestMeasurement[]): AgentPerformance => {
	const sorted = samples.toSorted((a, b) => a.startedAt - b.startedAt);
	let outputTokens = 0;
	let requestDurationMs = 0;
	let generationDurationMs = 0;
	let requestCount = 0;
	let complete = samples.length > 0;
	for (const sample of sorted) {
		const duration = (sample.completedAt ?? sample.startedAt) - sample.startedAt;
		if (sample.outputTokens === undefined || duration <= 0) {
			complete = false;
			continue;
		}
		outputTokens += sample.outputTokens;
		requestDurationMs += duration;
		requestCount++;
		if (
			sample.firstTokenAt === undefined
			|| sample.firstTokenAt < sample.startedAt
			|| sample.firstTokenAt >= sample.completedAt!
		) {
			complete = false;
		} else generationDurationMs += sample.completedAt! - sample.firstTokenAt;
	}
	const first = sorted.find(
		(sample) => sample.outputTokens !== undefined && (sample.completedAt ?? sample.startedAt) > sample.startedAt,
	);
	const firstTokenLatencyMs =
		first?.firstTokenAt !== undefined
		&& first.firstTokenAt >= first.startedAt
		&& first.firstTokenAt < first.completedAt!
			? first.firstTokenAt - first.startedAt
			: undefined;
	return {
		turnId,
		outputTokens,
		requestCount,
		requestDurationMs,
		...(complete && generationDurationMs > 0 ? { generationDurationMs } : {}),
		...(firstTokenLatencyMs !== undefined ? { firstTokenLatencyMs } : {}),
		state: requestCount === 0 ? "unavailable" : complete ? "complete" : "partial",
	};
};
