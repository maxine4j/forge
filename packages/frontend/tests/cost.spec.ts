import { expect, test } from "@playwright/test";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const since = "2026-11-03T00:00:00.000Z";
const tokens = { input: 1800, cached: 600, output: 200, turns: 2 };
const cost = {
	weeklyBudget: {
		defaultBucketId: "codex",
		buckets: ["codex", "other"].map((bucketId) => ({
			bucketId,
			bucket: bucketId,
			remainingPercent: 40,
			lastObservedAt: since,
			resetsAt: "2026-11-10T00:00:00.000Z",
			fresh: true,
			additionalTickets: 8 as number | undefined,
			completedTickets: 3,
			coverageHours: 24,
			consumption: 15,
			observations: [
				{
					bucketId,
					bucket: bucketId,
					observedAt: since,
					minutes: 10080,
					usedPercent: 60,
					resetsAt: "2026-11-10T00:00:00.000Z",
				},
			],
		})),
	},
	since,
	monthlyAud: 30,
	audPerUsd: 1.44,
	exchangeDate: "2026-11-10",
	totals: tokens,
	phases: [{ phase: "review", ...tokens }],
	days: [{ date: "2026-11-10", input: 1800, cached: 600, output: 200 }],
	tickets: [
		{
			id: "FORGE-2",
			title: "Search",
			...tokens,
			subscriptionAud: 0.015,
			apiAud: 0.09,
			untimedTurns: 0,
			unpricedTurns: 1,
		},
		{
			id: "FORGE-1",
			title: "Cleanup",
			archivedAt: since,
			input: 0,
			cached: 0,
			output: 0,
			turns: 0,
			untimedTurns: 0,
			unpricedTurns: 0,
		},
	],
	limits: {
		plan: "plus",
		windows: [
			{ bucket: "Codex", minutes: 300, usedPercent: 42, resetsAt: "2026-11-12T00:00:00.000Z" },
			{ bucket: "Codex", minutes: 10080, usedPercent: 67 },
		],
	},
};

test("Cost deep links render charts, ticket estimates and account windows on mobile", async ({ page }) => {
	let unavailable = true;
	let costReads = 0;
	await page.clock.install();
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		(route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/api/projects")
				return route.fulfill({ json: [{ id: projectId, name: "Forge", status: "ready", createdAt: since }] });
			if (path === "/api/accounts")
				return route.fulfill({
					json: {
						codex: { connection: "available", login: { state: "idle" } },
						github: { connection: "available", login: { state: "idle" } },
					},
				});
			if (path.endsWith("/cost")) {
				costReads++;
				if (unavailable) return route.fulfill({ status: 503, json: {} });
				return route.fulfill({ json: cost });
			}
			return route.fulfill({ json: [] });
		},
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(`/projects/${projectId}/cost`);
	await expect(page.getByRole("tab", { name: "Cost" })).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("alert")).toHaveText("Cost data is unavailable.");
	unavailable = false;
	await page.getByRole("button", { name: "Retry" }).click();
	await expect(page.getByRole("img", { name: "Daily token usage" })).toBeVisible();
	await expect(page.getByRole("img", { name: "codex weekly remaining allowance from 100% to 0%" })).toBeVisible();
	await expect(page.getByText(/Estimated additional tickets:.*≈ 8/)).toBeVisible();
	await page.getByLabel("Weekly bucket", { exact: true }).selectOption("other");
	await expect(page.getByRole("img", { name: "other weekly remaining allowance from 100% to 0%" })).toBeVisible();
	await page.getByText("Recorded timestamp and remaining allowance").click();
	cost.weeklyBudget.buckets[1]!.additionalTickets = undefined;
	Object.assign(cost.weeklyBudget.buckets[1]!, { unavailable: "learning" });
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(page.getByText(/Estimated additional tickets:.*Learning usage pattern/)).toBeVisible();
	Object.assign(cost.weeklyBudget.buckets[1]!, { unavailable: "stale", fresh: false });
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(page.getByText(/Unavailable: latest observation/)).toBeVisible();
	await expect(page.getByRole("img", { name: "Tokens by phase" })).toContainText("Review");
	await expect(page.getByText("5-hour window")).toBeVisible();
	await expect(page.getByText("Weekly window")).toBeVisible();
	const ticket = page.getByRole("row", { name: /FORGE-2 Search/ });
	await expect(ticket).toContainText("A$0.015");
	await expect(ticket).toContainText("A$0.09");
	await expect(ticket).toContainText("1 turn missing pricing");
	await expect(page.getByRole("row", { name: /FORGE-1 Cleanup/ })).toContainText("Archived");
	await page.getByRole("button", { name: "Ticket", exact: true }).click();
	await expect(page.getByRole("row").nth(1)).toContainText("FORGE-1");
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	const previousReads = costReads;
	await page.clock.fastForward(300_000);
	await expect.poll(() => costReads).toBeGreaterThan(previousReads);
	await page.setViewportSize({ width: 1280, height: 900 });
	await expect(page.getByRole("img", { name: "other weekly remaining allowance from 100% to 0%" })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
