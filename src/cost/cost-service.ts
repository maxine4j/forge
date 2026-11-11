import { costPhaseSchema, type ProjectCost } from "@forge/contracts";

import type { Actor } from "../auth/types.ts";
import type { ICodexLimits } from "../codex/codex-usage-client.ts";
import { apiCostAud } from "./api-pricing.ts";
import type { ICostHistory } from "./cost-store.ts";
import type { CostSettings, TokenCounts, UsageTurn } from "./types.ts";

export interface ICostProjects {
	/** Checks owner access and project existence. */
	get(actor: Actor, projectId: string): Promise<unknown>;
}

export interface ICostTickets {
	list(projectId: string): Promise<{ id: string; title: string }[]>;
}

export interface ICostService {
	read(actor: Actor, projectId: string): Promise<ProjectCost>;
}

const empty = () => ({ input: 0, cached: 0, output: 0, turns: 0 });
const dayMs = 86_400_000;

export class CostService implements ICostService {
	constructor(
		private readonly projects: ICostProjects,
		private readonly tickets: ICostTickets,
		private readonly store: ICostHistory,
		private readonly codex: ICodexLimits,
		private readonly settings: CostSettings,
		private readonly now: () => Date,
	) {}

	async read(actor: Actor, projectId: string): Promise<ProjectCost> {
		await this.projects.get(actor, projectId);
		const [{ since, turns }, tickets, limits] = await Promise.all([
			this.store.read(projectId),
			this.tickets.list(projectId),
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
		const ticketRows: ProjectCost["tickets"] = tickets.map((ticket) => ({
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
			const subscription = this.subscriptionCost(turn);
			if (subscription === undefined) ticket.untimedTurns++;
			else ticket.subscriptionAud = (ticket.subscriptionAud ?? 0) + subscription;
			const api = turn.input === undefined ? undefined : apiCostAud(turn.model, tokens, this.settings.audPerUsd);
			if (api === undefined) ticket.unpricedTurns++;
			else ticket.apiAud = (ticket.apiAud ?? 0) + api;
		}
		return {
			since,
			totals,
			phases: [...phases.values()].filter((phase) => phase.turns),
			days,
			tickets: ticketRows,
			limits,
			...this.settings,
		};
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
