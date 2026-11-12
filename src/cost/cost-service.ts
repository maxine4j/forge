import { costPhaseSchema, type Costs, type TicketCost } from "@forge/contracts";
import { ticketIdSchema } from "@forge/contracts/tickets";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { ICodexLimits } from "../codex/codex-usage-client.ts";
import { TicketError } from "../tickets/errors.ts";
import { apiCostAud } from "./api-pricing.ts";
import type { ICostHistory } from "./cost-store.ts";
import type { IQuotaStore } from "./quota-store.ts";
import type { CostSettings, TokenCounts, UsageTurn } from "./types.ts";
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

const empty = () => ({ input: 0, cached: 0, output: 0, turns: 0 });
const dayMs = 86_400_000;

export class CostService implements ICostService {
	constructor(
		private readonly access: Pick<IAccessService, "assertOwner">,
		private readonly tickets: ICostTickets,
		private readonly store: ICostHistory,
		private readonly codex: ICodexLimits,
		private readonly settings: CostSettings,
		private readonly now: () => Date,
		private readonly quotas?: IQuotaStore,
	) {}

	async read(actor: Actor): Promise<Costs> {
		this.access.assertOwner(actor);
		const [{ since, turns }, tickets, limits] = await Promise.all([
			this.store.read(),
			this.tickets.listForCost(),
			this.codex.limits(),
		]);
		const today = this.now();
		today.setUTCHours(0, 0, 0, 0);
		const days = Array.from({ length: 30 }, (_, index) => ({
			date: new Date(today.getTime() - (29 - index) * dayMs).toISOString().slice(0, 10),
			input: 0,
			cached: 0,
			output: 0,
		}));
		const byDay = new Map(days.map((day) => [day.date, day]));
		const phases = new Map(costPhaseSchema.options.map((phase) => [phase, { phase, ...empty() }]));
		const totals = empty();
		const ticketRows: Costs["tickets"] = tickets.map((ticket) => ({
			...ticket,
			...empty(),
			untimedTurns: 0,
			unpricedTurns: 0,
		}));
		const byTicket = new Map(ticketRows.map((ticket) => [ticket.id, ticket]));
		for (const turn of turns) {
			const tokens = { input: turn.input ?? 0, cached: turn.cached ?? 0, output: turn.output ?? 0 };
			this.add(totals, tokens);
			const phase = phases.get(turn.phase);
			if (phase) this.add(phase, tokens);
			const day = byDay.get(turn.startedAt.slice(0, 10));
			if (day) this.add(day, tokens);
			const ticket = turn.ticketId ? byTicket.get(turn.ticketId) : undefined;
			if (!ticket) continue;
			this.add(ticket, tokens);
			this.estimate(ticket, turn);
		}
		const ticketEstimates = {
			...empty(),
			untimedTurns: 0,
			unpricedTurns: 0,
			subscriptionAud: 0,
			apiAud: 0,
		};
		for (const ticket of ticketRows) {
			ticketEstimates.input += ticket.input;
			ticketEstimates.cached += ticket.cached;
			ticketEstimates.output += ticket.output;
			ticketEstimates.turns += ticket.turns;
			ticketEstimates.untimedTurns += ticket.untimedTurns;
			ticketEstimates.unpricedTurns += ticket.unpricedTurns;
			if (ticket.subscriptionAud !== undefined)
				ticketEstimates.subscriptionAud = (ticketEstimates.subscriptionAud ?? 0) + ticket.subscriptionAud;
			if (ticket.apiAud !== undefined) ticketEstimates.apiAud = (ticketEstimates.apiAud ?? 0) + ticket.apiAud;
		}
		return {
			ticketEstimates,
			weeklyBudget: this.quotas ? await this.readWeeklyBudget() : undefined,
			since,
			totals,
			phases: [...phases.values()].filter((phase) => phase.turns),
			days,
			tickets: ticketRows,
			limits,
			...this.settings,
		};
	}
	async readTicket(actor: Actor, ticketId: string): Promise<TicketCost> {
		this.access.assertOwner(actor);
		if (!ticketIdSchema.safeParse(ticketId).success) throw new TicketError("invalid-request");
		const metadata = await this.tickets.get(ticketId);
		if (!metadata) throw new TicketError("ticket-not-found");
		const { since, turns } = await this.store.read(ticketId);
		const ticket = { ...empty(), untimedTurns: 0, unpricedTurns: 0 };
		for (const turn of turns) {
			if (turn.ticketId !== ticketId) continue;
			this.add(ticket, { input: turn.input ?? 0, cached: turn.cached ?? 0, output: turn.output ?? 0 });
			this.estimate(ticket, turn);
		}
		return { since, ...this.settings, ticket };
	}
	private estimate(ticket: TicketCost["ticket"], turn: UsageTurn) {
		const subscription = this.subscriptionCost(turn);
		if (subscription === undefined) ticket.untimedTurns++;
		else ticket.subscriptionAud = (ticket.subscriptionAud ?? 0) + subscription;
		const api =
			turn.input === undefined
				? undefined
				: apiCostAud(
						turn.model,
						{ input: turn.input, cached: turn.cached ?? 0, output: turn.output ?? 0 },
						this.settings.audPerUsd,
					);
		if (api === undefined) ticket.unpricedTurns++;
		else ticket.apiAud = (ticket.apiAud ?? 0) + api;
	}
	private async readWeeklyBudget() {
		const now = this.now();
		const history = await this.quotas!.read(new Date(now.getTime() - 28 * dayMs).toISOString());
		return weeklyBudget(history.observations, history.completions, now);
	}

	private add(summary: TokenCounts & { turns?: number }, tokens: TokenCounts): void {
		summary.input += tokens.input;
		summary.cached += tokens.cached;
		summary.output += tokens.output;
		if (summary.turns !== undefined) summary.turns++;
	}

	private subscriptionCost(turn: UsageTurn): number | undefined {
		if (turn.durationMs === undefined) return undefined;
		let cursor = Date.parse(turn.startedAt);
		const end = cursor + turn.durationMs;
		let cost = 0;
		while (cursor < end) {
			const month = new Date(cursor);
			month.setUTCDate(1);
			month.setUTCHours(0, 0, 0, 0);
			const start = month.getTime();
			const next = month.setUTCMonth(month.getUTCMonth() + 1);
			const segment = Math.min(next, end);
			cost += (turn.monthlyAud * (segment - cursor)) / (next - start);
			cursor = segment;
		}
		return cost;
	}
}
