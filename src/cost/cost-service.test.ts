import { expect, test, vi } from "vitest";

import { CostService } from "./cost-service.ts";
import type { UsageTurn } from "./types.ts";

test("aggregates all phases, chats, archived and repository-free tickets without repository joins", async () => {
	const startedAt = "2026-10-31T23:00:00.000Z";
	const planning = {
		projectId: "a",
		ticketId: "TASK-1",
		threadId: "one",
		turnId: "one",
		phase: "planning" as const,
		startedAt,
		billing: { localCurrency: "AUD", monthlyPlanLocal: 30, usdToLocal: 1.5 },
		apiUsd: 2.875,
		input: 1000000,
		cached: 500000,
		output: 100000,
	};
	const turns: UsageTurn[] = [
		planning,
		{ ...planning, phase: "implementation", turnId: "two", projectId: "another-repository" },
		{ ...planning, phase: "review", turnId: "three", apiUsd: undefined },
		{ ...planning, phase: "rebase", turnId: "four", ticketId: "TASK-3" },
		{ ...planning, phase: "chat", turnId: "five", ticketId: undefined },
	];
	const access = { assertOwner: vi.fn() };
	const service = new CostService(
		access,
		{
			get: async (id) => ({ id }),
			listForCost: async () => [
				{ id: "TASK-1", title: "Search", archivedAt: startedAt },
				{ id: "TASK-2", title: "No repository or usage" },
				{ id: "TASK-3", title: "Other" },
			],
		},
		{ read: async () => ({ since: startedAt, turns }) },
		{ limits: async () => undefined },
		() => new Date("2026-11-01T00:00:00Z"),
	);
	const result = await service.read({ username: "owner" });
	expect(access.assertOwner).toHaveBeenCalledWith({ username: "owner" });
	expect(result.totals).toMatchObject({ input: 5000000, cached: 2500000, output: 500000, turns: 5, apiUsd: 11.5 });
	expect(result.ticketEstimates).toMatchObject({
		turns: 4,
		apiUsd: 8.625,
		incomplete: { api: 1, weekly: 4, effective: 4 },
	});
	expect(result.chats).toMatchObject({ turns: 1, apiUsd: 2.875 });
	expect(result.phases.map(({ phase }) => phase)).toEqual(["planning", "implementation", "review", "rebase", "chat"]);
	expect(result.days).toHaveLength(30);
	expect(result.days.at(-2)).toMatchObject({ date: "2026-10-31", input: 5000000 });
	expect(result.tickets[0]).toMatchObject({
		id: "TASK-1",
		archivedAt: startedAt,
		turns: 3,
		apiUsd: 5.75,
		localCurrencies: [{ currency: "AUD", api: 8.625 }],
	});
	expect(result.tickets[0]?.phases.map((phase) => phase.turns)).toEqual([1, 1, 1, 0]);
	expect(result.tickets[1]).toMatchObject({ turns: 0, apiUsd: 0, weeklyUsagePercent: 0, effectiveUsd: 0 });
	const scoped = await service.readTicket({ username: "owner" }, "TASK-1");
	expect(scoped.ticket).toEqual(expect.objectContaining({ turns: 3, apiUsd: 5.75 }));
	expect(scoped.phases.map((phase) => phase.turns)).toEqual([1, 1, 1, 0]);
	await expect(service.readTicket({ username: "owner" }, "invalid")).rejects.toThrow();
});
