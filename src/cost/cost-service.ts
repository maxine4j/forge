import { costPhaseSchema, costRangeSchema, defaultCostRange, type Costs, type TicketCost } from "@forge/contracts";
import { ticketIdSchema } from "@forge/contracts/tickets";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { ICodexLimits } from "../codex/codex-usage-client.ts";
import { TicketError } from "../tickets/errors.ts";
import type { ICostHistory } from "./cost-store.ts";
import { summarizeCosts } from "./cost-summary.ts";
import type { QuotaInterval } from "./quota-attribution.ts";
import type { IQuotaStore } from "./quota-store.ts";
import type { CostWindow, TokenCounts, UsageTurn } from "./types.ts";
import { weeklyBudget } from "./weekly-budget.ts";

export interface ICostTickets {
	/** Includes archived tickets and tickets without recorded usage. */
	listForCost(): Promise<{ id: string; title: string; archivedAt?: string }[]>;
	get(id: string): Promise<{ id: string } | undefined>;
}
export interface ICostService {
	read(actor: Actor, range?: string): Promise<Costs>;
	readTicket(actor: Actor, ticketId: string, range?: string): Promise<TicketCost>;
}
const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
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
	async read(actor: Actor, range = defaultCostRange): Promise<Costs> {
		this.access.assertOwner(actor);
		const now = this.now();
		const window = this.window(range, now);
		const [{ since, turns }, tickets, limits, intervals, history] = await Promise.all([
			this.store.read(undefined, window),
			this.tickets.listForCost(),
			this.codex.limits(),
			this.quotas?.intervals?.(window) ?? [],
			this.quotas?.read(window.from),
		]);
		const chartStart = Math.max(Date.parse(window.from), Date.parse(since));
		const days = this.tokenSeries(turns, chartStart, now.getTime(), dayMs);
		const hours =
			now.getTime() - Date.parse(window.from) <= dayMs && range.endsWith("hr")
				? this.tokenSeries(turns, chartStart, now.getTime(), hourMs)
				: undefined;
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
		return {
			since,
			limits,
			days,
			hours,
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
			weeklyBudget: history
				? weeklyBudget(history.observations, history.completions, now, Date.parse(window.from))
				: undefined,
		};
	}
	async readTicket(actor: Actor, ticketId: string, range = defaultCostRange): Promise<TicketCost> {
		this.access.assertOwner(actor);
		if (!ticketIdSchema.safeParse(ticketId).success) throw new TicketError("invalid-request");
		const window = this.window(range, this.now());
		if (!(await this.tickets.get(ticketId))) throw new TicketError("ticket-not-found");
		const [{ since, turns }, intervals] = await Promise.all([
			this.store.read(ticketId, window),
			this.quotas?.intervals?.(window) ?? [],
		]);
		const attributed = turns.filter((turn) => turn.ticketId === ticketId);
		return { since, ticket: summarizeCosts(attributed, intervals), phases: phases(attributed, intervals) };
	}

	private window(range: string, now: Date): CostWindow {
		if (!costRangeSchema.safeParse(range).success) throw new TicketError("invalid-request");
		const unit = range.endsWith("hr") ? hourMs : dayMs;
		const start = now.getTime() + Number.parseInt(range, 10) * unit;
		const earliest = Date.parse("0000-01-01T00:00:00.000Z");
		return { from: new Date(Math.max(earliest, start)).toISOString(), to: now.toISOString() };
	}

	private tokenSeries(turns: UsageTurn[], start: number, end: number, step: number) {
		const bucket = (time: number) => Math.floor(time / step) * step;
		const totals = new Map<number, TokenCounts>();
		for (const turn of turns) {
			const time = bucket(Date.parse(turn.startedAt));
			const counts = totals.get(time) ?? { input: 0, cached: 0, output: 0 };
			counts.input += turn.input ?? 0;
			counts.cached += turn.cached ?? 0;
			counts.output += turn.output ?? 0;
			totals.set(time, counts);
		}
		const series = [];
		for (let time = bucket(start); time <= end; time += step) {
			const date = new Date(time).toISOString();
			series.push({
				date: step === dayMs ? date.slice(0, 10) : date,
				...(totals.get(time) ?? { input: 0, cached: 0, output: 0 }),
			});
		}
		return series;
	}
}
