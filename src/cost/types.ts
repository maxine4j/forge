import type { TicketWorkflow } from "@forge/contracts/tickets";

export interface CostSettings {
	monthlyAud: number;
	audPerUsd: number;
	exchangeDate: string;
}

export interface TicketUsageScope {
	phase: TicketWorkflow["phase"];
	ticketId: string;
}

export type UsageScope = { projectId: string } & ({ phase: "chat"; ticketId?: undefined } | TicketUsageScope);

export interface TokenCounts {
	input: number;
	cached: number;
	output: number;
}

export type UsageSnapshot = UsageScope & {
	threadId: string;
	startedAt: string;
	durationMs?: number;
	monthlyAud: number;
	model?: string;
	input?: number;
	cached?: number;
	output?: number;
};

export type UsageTurn = UsageSnapshot & { turnId: string };

export interface AccountLimits {
	plan?: string;
	windows: { bucketId?: string; bucket: string; minutes?: number; usedPercent: number; resetsAt?: string }[];
}
