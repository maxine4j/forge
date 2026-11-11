import { expect, test, vi } from "vitest";

import type { AccountNotification } from "../accounts/types.ts";
import { CodexUsageClient } from "./codex-usage-client.ts";

test("records cumulative changes once per turn and preserves the dispatch phase", async () => {
	let notify: AccountNotification = () => undefined;
	const save = vi.fn(async () => {});
	const client = new CodexUsageClient(
		{
			initialize: async () => {},
			request: async () => ({}),
			subscribe: (listener) => {
				notify = listener;
				return () => {};
			},
		},
		save,
		() => new Date("2026-11-11T00:00:00Z"),
		30,
	);
	const scope = { projectId: "project", ticketId: "FORGE-1", phase: "review" } as const;
	client.track("thread", scope, "gpt-5.4");
	const breakdown = (inputTokens: number, outputTokens: number) => ({
		inputTokens,
		outputTokens,
		cachedInputTokens: inputTokens / 2,
		reasoningOutputTokens: 0,
		totalTokens: inputTokens + outputTokens,
	});
	const sample = (turnId: string, total: ReturnType<typeof breakdown>, last: ReturnType<typeof breakdown>) =>
		notify("thread/tokenUsage/updated", { threadId: "thread", turnId, tokenUsage: { total, last } });
	sample("turn", breakdown(120, 25), breakdown(20, 5));
	sample("turn", breakdown(130, 28), breakdown(10, 3));
	sample("turn", breakdown(130, 28), breakdown(10, 3));
	notify("turn/completed", { threadId: "thread", turn: { id: "turn", startedAt: 1794355200, durationMs: 5000 } });
	client.track("thread", { ...scope, phase: "rebase" }, "gpt-5.4");
	sample("turn", breakdown(130, 28), breakdown(10, 3));
	sample("next", breakdown(140, 30), breakdown(10, 2));
	await client.close();
	expect(save).toHaveBeenCalledTimes(4);
	expect(save).toHaveBeenNthCalledWith(
		3,
		expect.objectContaining({
			...scope,
			turnId: "turn",
			input: 30,
			cached: 15,
			output: 8,
			durationMs: 5000,
			monthlyAud: 30,
		}),
	);
	expect(save).toHaveBeenLastCalledWith(
		expect.objectContaining({
			phase: "rebase",
			turnId: "next",
			input: 10,
			cached: 5,
			output: 2,
		}),
	);
});

test("returns reported quota windows and omits private account data", async () => {
	const request = vi.fn(async () => ({
		accountId: "private",
		rateLimits: {},
		rateLimitsByLimitId: {
			codex: {
				planType: "plus",
				primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1794355200 },
				secondary: { usedPercent: 75, windowDurationMins: 10080 },
			},
		},
	}));
	const client = new CodexUsageClient(
		{ initialize: async () => {}, request, subscribe: () => () => {} },
		async () => {},
		() => new Date(0),
		30,
	);
	expect(await client.limits()).toEqual({
		plan: "plus",
		windows: [
			{ bucket: "codex", minutes: 300, usedPercent: 25, resetsAt: "2026-11-11T00:00:00.000Z" },
			{ bucket: "codex", minutes: 10080, usedPercent: 75 },
		],
	});
	expect(request).toHaveBeenCalledWith("account/rateLimits/read", null);
	request.mockRejectedValueOnce(new Error("signed out"));
	expect(await client.limits()).toBeUndefined();
});
