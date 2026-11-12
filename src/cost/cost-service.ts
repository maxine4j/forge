import { costPhaseSchema, type Costs, type TicketCost } from "@forge/contracts";
import { ticketIdSchema } from "@forge/contracts/tickets";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { ICodexLimits } from "../codex/codex-usage-client.ts";
import { TicketError } from "../tickets/errors.ts";
import type { ICostHistory } from "./cost-store.ts";
import { summarizeCosts } from "./cost-summary.ts";
import type { QuotaInterval } from "./quota-attribution.ts";
import type { IQuotaStore } from "./quota-store.ts";
import type { UsageTurn } from "./types.ts";
import { weeklyBudget } from "./weekly-budget.ts";

export interface ICostTickets {
	/** Includes archived tickets and tickets without recorded usage. */
	listForCost(): Promise<{ id: string; title: string; archivedAt?: string }[]>;
	get(id: string): Promise<{ id: string } | undefined>;
}
export interface ICostService {
	read(actor: Actor): Promise<Costs>;
	readTicket(actor: Actor, ticketId: string): Promise<TicketCost>;
}
const dayMs = 86_400_000;
const phases = (turns: UsageTurn[], intervals: QuotaInterval[], chat = false) =>
	costPhaseSchema.options
		.filter((phase) => chat || phase !== "chat")
		.map((phase) => ({
			phase,
			...summarizeCosts(
				turns.filter((turn) => turn.phase === phase),
				intervals,
			),
		}));

export class CostService implements ICostService {
	constructor(
		private readonly access: Pick<IAccessService, "assertOwner">,
		private readonly tickets: ICostTickets,
		private readonly store: ICostHistory,
		private readonly codex: ICodexLimits,
		private readonly now: () => Date,
		private readonly quotas?: IQuotaStore,
	) {}
	async read(actor: Actor): Promise<Costs> {
		this.access.assertOwner(actor);
		const [{ since, turns }, tickets, limits, intervals] = await Promise.all([
			this.store.read(),
			this.tickets.listForCost(),
			this.codex.limits(),
			this.quotas?.intervals?.() ?? [],
		]);
		const today = this.now();
		today.setUTCHours(0, 0, 0, 0);
		const days = Array.from({ length: 30 }, (_, index) => {
			const date = new Date(today.getTime() - (29 - index) * dayMs).toISOString().slice(0, 10);
			const summary = summarizeCosts(
				turns.filter((turn) => turn.startedAt.slice(0, 10) === date),
				[],
			);
			return { date, input: summary.input, cached: summary.cached, output: summary.output };
		});
		const quotaAttribution: Costs["quotaAttribution"] = [];
		for (const interval of intervals) {
			const bucket = quotaAttribution.find((value) => value.bucketId === interval.bucketId) ?? {
				bucketId: interval.bucketId,
				consumption: 0,
				allocated: 0,
				unallocated: 0,
			};
			if (!quotaAttribution.includes(bucket)) quotaAttribution.push(bucket);
			bucket.consumption += interval.consumption;
			bucket.unallocated += interval.unallocated;
			bucket.allocated += interval.consumption - interval.unallocated;
		}
		const history = await this.quotas?.read(new Date(this.now().getTime() - 28 * dayMs).toISOString());
		return {
			since,
			limits,
			days,
			quotaAttribution,
			totals: summarizeCosts(turns, intervals),
			chats: summarizeCosts(
				turns.filter((turn) => turn.phase === "chat"),
				intervals,
			),
			ticketEstimates: summarizeCosts(
				turns.filter((turn) => turn.ticketId !== undefined),
				intervals,
			),
			phases: phases(turns, intervals, true),
			tickets: tickets.map((ticket) => {
				const attributed = turns.filter((turn) => turn.ticketId === ticket.id);
				return { ...ticket, ...summarizeCosts(attributed, intervals), phases: phases(attributed, intervals) };
			}),
			weeklyBudget: history ? weeklyBudget(history.observations, history.completions, this.now()) : undefined,
		};
	}
	async readTicket(actor: Actor, ticketId: string): Promise<TicketCost> {
		this.access.assertOwner(actor);
		if (!ticketIdSchema.safeParse(ticketId).success) throw new TicketError("invalid-request");
		if (!(await this.tickets.get(ticketId))) throw new TicketError("ticket-not-found");
		const [{ since, turns }, intervals] = await Promise.all([
			this.store.read(ticketId),
			this.quotas?.intervals?.() ?? [],
		]);
		const attributed = turns.filter((turn) => turn.ticketId === ticketId);
		return { since, ticket: summarizeCosts(attributed, intervals), phases: phases(attributed, intervals) };
	}
}
