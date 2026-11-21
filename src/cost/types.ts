import type { TicketWorkflow } from "@forge/contracts/tickets";

export interface CostSettings {
	localCurrency: string;
	monthlyPlanLocal: number;
}

export interface BillingSnapshot extends CostSettings {
	usdToLocal?: number;
	usdToAud?: number;
	rateDate?: string;
	fetchedAt?: string;
	rates?: TokenCounts;
}

export interface TicketUsageScope {
	phase: TicketWorkflow["phase"];
	ticketId: string;
}

export type UsageScope = { projectId: string; providerId?: string } & (
	| { phase: "chat"; ticketId?: undefined }
	| TicketUsageScope
);

export interface TokenCounts {
	input: number;
	cached: number;
	output: number;
}

export interface CostWindow {
	from: string;
	to: string;
}

export type UsageSnapshot = UsageScope & {
	threadId: string;
	startedAt: string;
	durationMs?: number;
	billing: BillingSnapshot;
	apiUsd?: number;
	pricingUnavailable?: boolean;
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
