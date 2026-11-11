import { expect, test, vi } from "vitest";

import { CostService } from "./cost-service.ts";
import type { UsageTurn } from "./types.ts";

test("aggregates phase and daily usage, splits time across months, and flags unpriced turns", async () => {
	const startedAt = "2026-10-31T23:00:00.000Z";
	const planning: UsageTurn = {
		projectId: "a",
		ticketId: "FORGE-1",
		threadId: "one",
		turnId: "one",
		phase: "planning",
		startedAt,
		durationMs: 7200000,
		monthlyAud: 30,
		model: "gpt-5.4",
		input: 1000000,
		cached: 500000,
		output: 100000,
	};
	const turns: UsageTurn[] = [
		planning,
		{
			...planning,
			turnId: "two",
			phase: "review",
			durationMs: 0,
			model: "unknown",
			input: 100,
			cached: 0,
			output: 10,
		},
		{ ...planning, ticketId: undefined, phase: "chat", turnId: "three", input: 20, cached: 0, output: 10 },
	];
	const projects = { get: vi.fn(async () => ({})) };
	const service = new CostService(
		projects,
		{
			list: async () => [
				{ id: "FORGE-1", title: "Search" },
				{ id: "FORGE-2", title: "Waiting" },
			],
		},
		{ read: async () => ({ since: startedAt, turns }) },
		{ limits: async () => undefined },
		{ monthlyAud: 30, audPerUsd: 1.5, exchangeDate: "2026-11-10" },
		() => new Date("2026-11-01T00:00:00Z"),
	);
	const result = await service.read({ username: "owner" }, "a");
	expect(projects.get).toHaveBeenCalledWith({ username: "owner" }, "a");
	expect(result.totals).toMatchObject({ input: 1000120, cached: 500000, output: 100020, turns: 3 });
	expect(result.phases.map(({ phase }) => phase)).toEqual(["planning", "review", "chat"]);
	expect(result.days).toHaveLength(30);
	expect(result.days.at(-2)).toMatchObject({ date: "2026-10-31", input: 1000120 });
	expect(result.days.at(-1)).toMatchObject({ date: "2026-11-01", input: 0 });
	expect(result.tickets.at(0)?.subscriptionAud).toBeCloseTo(30 / (31 * 24) + 30 / (30 * 24));
	expect(result.tickets.at(0)).toMatchObject({ id: "FORGE-1", apiAud: 4.3125, unpricedTurns: 1, turns: 2 });
	expect(result.tickets.at(1)).toMatchObject({ id: "FORGE-2", turns: 0 });
	expect(result.tickets.at(1)?.apiAud).toBeUndefined();
	expect(result.limits).toBeUndefined();
});
