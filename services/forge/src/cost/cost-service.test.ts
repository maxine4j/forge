import { expect, test, vi } from "vitest";

import { CostService } from "./cost-service.ts";
import type { QuotaInterval } from "./quota-attribution.ts";
import type { UsageTurn } from "./types.ts";

test("aggregates all phases, chats, archived and repository-free tickets without repository joins", async () => {
	const startedAt = "2026-10-31T23:00:00.000Z";
	const planning = {
		projectId: "a",
		ticketId: "TASK-1",
		providerId: "cloud",
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
		{
			...planning,
			phase: "chat",
			turnId: "five",
			ticketId: undefined,
			billing: { localCurrency: "EUR", monthlyPlanLocal: 30, usdToLocal: 0.9, usdToAud: 1.5 },
		},
		{ ...planning, turnId: "prior", startedAt: "2026-10-31T22:59:59.999Z" },
		{ ...planning, turnId: "future", startedAt: "2026-11-01T00:00:00.001Z" },
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
		{
			read: async (ticketId, window) => ({
				since: "2026-10-01T00:00:00.000Z",
				turns: turns.filter(
					(turn) =>
						(!ticketId || turn.ticketId === ticketId)
						&& (!window || (turn.startedAt >= window.from && turn.startedAt <= window.to)),
				),
			}),
		},
		{ limits: async () => undefined },
		() => new Date("2026-11-01T00:00:00Z"),
		undefined,
		{
			list: async () => [
				{ id: "cloud", name: "Cloud", kind: "openai" as const, retired: false },
				{ id: "old", name: "Previous provider", kind: "openai" as const, retired: true },
				{ id: "local", name: "Local", kind: "ollama" as const, retired: false },
			],
		},
	);
	const result = await service.read({ username: "owner" });
	expect(result.providers).toMatchObject([
		{
			id: "cloud",
			name: "Cloud",
			kind: "openai",
			current: true,
			apiAud: 21.5625,
			incomplete: 1,
			workSharePercent: 100,
		},
		{ id: "local", name: "Local", kind: "ollama", apiAud: 0, weeklySavedPercent: 0, workSharePercent: 0 },
	]);
	expect(access.assertOwner).toHaveBeenCalledWith({ username: "owner" });
	expect(result.totals).toMatchObject({ input: 6000000, cached: 3000000, output: 600000, turns: 6, apiUsd: 14.375 });
	expect(result.ticketEstimates).toMatchObject({
		turns: 5,
		apiUsd: 11.5,
		incomplete: { api: 1, weekly: 5, effective: 5 },
	});
	expect(result.chats).toMatchObject({ turns: 1, apiUsd: 2.875 });
	expect(result.phases.map(({ phase }) => phase)).toEqual(["planning", "implementation", "review", "rebase", "chat"]);
	expect(result.days).toHaveLength(8);
	expect(result.days.at(-2)).toMatchObject({ date: "2026-10-31", input: 6000000 });
	expect(result.tickets[0]).toMatchObject({
		id: "TASK-1",
		archivedAt: startedAt,
		turns: 4,
		apiUsd: 8.625,
		localCurrencies: [{ currency: "AUD", api: 12.9375 }],
	});
	expect(result.tickets[0]?.phases.map((phase) => phase.turns)).toEqual([2, 1, 1, 0]);
	expect(result.tickets[1]).toMatchObject({ turns: 0, apiUsd: 0, weeklyUsagePercent: 0, effectiveUsd: 0 });
	const recent = await service.read({ username: "owner" }, "-1hr");
	expect(recent.totals).toMatchObject({ turns: 5, apiUsd: 11.5 });
	expect(recent.hours).toEqual([
		{ date: startedAt, input: 5000000, cached: 2500000, output: 500000 },
		{ date: "2026-11-01T00:00:00.000Z", input: 0, cached: 0, output: 0 },
	]);
	const scoped = await service.readTicket({ username: "owner" }, "TASK-1", "-1hr");
	expect(scoped.ticket).toEqual(expect.objectContaining({ turns: 3, apiUsd: 5.75 }));
	expect(scoped.phases.map((phase) => phase.turns)).toEqual([1, 1, 1, 0]);
	await expect(service.readTicket({ username: "owner" }, "invalid")).rejects.toThrow();
});

test("keeps retired and unassigned OpenAI usage out of the current provider's total", async () => {
	const startedAt = "2026-10-31T23:00:00.000Z";
	const turn = {
		phase: "chat" as const,
		projectId: "project",
		threadId: "thread",
		startedAt,
		billing: { localCurrency: "AUD", monthlyPlanLocal: 30, usdToLocal: 1.5 },
	};
	const list = vi.fn(async () => [
		{ id: "current", name: "Current", kind: "openai" as const, retired: false },
		{ id: "retired", name: "Previous", kind: "openai" as const, retired: true },
	]);
	const service = new CostService(
		{ assertOwner: vi.fn() },
		{ get: async () => undefined, listForCost: async () => [] },
		{
			read: async () => ({
				since: startedAt,
				turns: [
					{ ...turn, turnId: "1", providerId: "current", apiUsd: 10 },
					{ ...turn, turnId: "2", providerId: "retired", apiUsd: 20 },
					{ ...turn, turnId: "3", apiUsd: 30 },
				],
			}),
		},
		{ limits: async () => undefined },
		() => new Date("2026-11-01T00:00:00Z"),
		undefined,
		{ list },
	);
	const result = await service.read({ username: "owner" });
	expect(list).toHaveBeenCalledWith(true);
	expect(result.providers).toMatchObject([
		{ id: "current", name: "Current", kind: "openai", current: true, apiAud: 15, incomplete: 0 },
		{ id: "retired", name: "Previous", kind: "openai", current: false, apiAud: 30, incomplete: 0 },
		{ id: "openai-history", name: "OpenAI history", kind: "openai", current: false, apiAud: 45, incomplete: 0 },
	]);
});

test("compares recorded tokens and benchmarks by provider while keeping Ollama out of OpenAI ticket costs", async () => {
	const startedAt = "2026-10-31T23:00:00.000Z";
	const now = "2026-11-01T00:00:00.000Z";
	const cloud: UsageTurn = {
		projectId: "repo",
		providerId: "cloud",
		threadId: "thread",
		turnId: "cloud",
		ticketId: "TASK-1",
		phase: "planning",
		startedAt,
		input: 1_000_000,
		cached: 800_000,
		output: 100_000,
		apiUsd: 2,
		billing: { localCurrency: "AUD", monthlyPlanLocal: 30, usdToLocal: 1.5 },
	};
	const local: UsageTurn = {
		...cloud,
		providerId: "local",
		providerKind: "ollama",
		turnId: "local",
		apiUsd: undefined,
		billing: {
			localCurrency: "EUR",
			monthlyPlanLocal: 30,
			usdToAud: 1.5,
			benchmark: { model: "gpt-5.4", rates: { input: 2.5, cached: 0.25, output: 15 } },
		},
	};
	const retired: UsageTurn = {
		...local,
		phase: "chat",
		ticketId: undefined,
		providerId: "retired",
		turnId: "retired",
		input: 100_000,
		cached: 0,
		output: 0,
		billing: {
			localCurrency: "AUD",
			monthlyPlanLocal: 30,
			usdToLocal: 2,
			benchmark: { model: "gpt-6.1-sol", rates: { input: 2, cached: 0.1, output: 10 } },
		},
	};
	const turns = [
		cloud,
		local,
		retired,
		{ ...local, turnId: "missing-fx", billing: { ...local.billing, usdToAud: undefined } },
		{ ...local, turnId: "missing-usage", input: undefined, cached: undefined, output: undefined },
		{ ...local, turnId: "missing-benchmark", billing: { ...local.billing, benchmark: undefined } },
	];
	const interval: QuotaInterval = {
		start: startedAt,
		end: now,
		bucketId: "codex",
		resetsAt: "2026-11-05T00:00:00.000Z",
		consumption: 5,
		unallocated: 0,
		allocations: [{ threadId: cloud.threadId, turnId: cloud.turnId, percent: 5, apiUsd: 2 }],
	};
	const intervals = vi.fn(async () => [interval]);
	const service = new CostService(
		{ assertOwner: vi.fn() },
		{ get: async (id) => ({ id }), listForCost: async () => [{ id: "TASK-1", title: "Mixed" }] },
		{
			read: async (ticketId) => ({
				since: startedAt,
				turns: turns.filter((turn) => !ticketId || turn.ticketId === ticketId),
			}),
		},
		{ limits: async () => undefined },
		() => new Date(now),
		{ save: vi.fn(), read: async () => ({ observations: [], completions: [] }), intervals },
		{
			list: async () => [
				{ id: "cloud", name: "Cloud", kind: "openai", retired: false },
				{ id: "local", name: "Local", kind: "ollama", retired: false },
				{ id: "retired", name: "Retired", kind: "ollama", retired: true },
				{ id: "empty", name: "Empty", kind: "ollama", retired: true },
			],
		},
	);
	const owner = { username: "owner" };
	const result = await service.read(owner);
	expect(result.providerTotals).toMatchObject({
		openai: { input: 1_000_000, apiAud: 3, incomplete: 0 },
		ollama: {
			input: 3_100_000,
			cached: 2_400_000,
			output: 300_000,
			apiAud: expect.closeTo(3.7),
			weeklySavedPercent: expect.closeTo(11.5),
			incomplete: 3,
			incompleteWeekly: 2,
			incompleteTokens: 1,
		},
	});
	expect(result.providers).toMatchObject([
		{ id: "cloud", workSharePercent: expect.closeTo((100 * 1.1) / 4.5) },
		{
			id: "local",
			workSharePercent: expect.closeTo((100 * 3.3) / 4.5),
			apiAud: expect.closeTo(3.3),
			weeklySavedPercent: 11,
		},
		{ id: "retired", workSharePercent: expect.closeTo((100 * 0.1) / 4.5), apiAud: 0.4, weeklySavedPercent: 0.5 },
	]);
	expect(result.days.at(-2)).toMatchObject({ input: 4_100_000, cached: 3_200_000, output: 400_000 });
	expect((await service.readTicket(owner, "TASK-1")).ticket).toMatchObject({
		input: 4_000_000,
		apiUsd: 2,
		weeklyUsagePercent: 5,
		incomplete: { api: 0, tokens: 1 },
	});
	intervals.mockResolvedValueOnce([interval, { ...interval, bucketId: "different" }]);
	expect((await service.read(owner)).providerTotals.ollama).toMatchObject({
		weeklySavedPercent: undefined,
		incompleteWeekly: 5,
	});
	intervals.mockResolvedValueOnce([]);
	expect((await service.read(owner)).providerTotals.ollama).toMatchObject({
		apiAud: expect.closeTo(3.7),
		weeklySavedPercent: undefined,
	});
});
