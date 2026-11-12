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
	ticketEstimates: { ...tokens, subscriptionAud: 0.015, apiAud: 0.09, untimedTurns: 0, unpricedTurns: 1 },
	phases: [{ phase: "review", ...tokens }],
	days: [{ date: "2026-11-10", input: 1800, cached: 600, output: 200 }],
	tickets: [
		{
			id: "TASK-2",
			title: "Search",
			...tokens,
			subscriptionAud: 0.015,
			apiAud: 0.09,
			untimedTurns: 0,
			unpricedTurns: 1,
		},
		{
			id: "TASK-1",
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
			if (path === "/api/projects") return route.fulfill({ json: [] });
			if (path === "/api/accounts")
				return route.fulfill({
					json: {
						codex: { connection: "available", login: { state: "idle" } },
						github: { connection: "available", login: { state: "idle" } },
					},
				});
			if (path === "/api/costs") {
				costReads++;
				if (unavailable) return route.fulfill({ status: 503, json: {} });
				return route.fulfill({ json: cost });
			}
			return route.fulfill({ json: [] });
		},
	);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto("/costs");
	await expect(page.getByRole("link", { name: "Repos", exact: true })).not.toHaveAttribute("aria-current");
	await expect(page.getByRole("link", { name: "Costs" })).toHaveAttribute("aria-current", "page");
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
	const ticket = page.getByRole("row", { name: /TASK-2 Search/ });
	await expect(ticket).toContainText("A$0.015");
	await expect(ticket).toContainText("A$0.09");
	await expect(ticket).toContainText("1 turn missing pricing");
	await expect(page.getByRole("row", { name: /TASK-1 Cleanup/ })).toContainText("Archived");
	await page.getByRole("button", { name: "Ticket", exact: true }).click();
	await expect(page.getByRole("row").nth(1)).toContainText("TASK-1");
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await expect(ticket.getByRole("link")).toHaveAttribute("href", `/tasks?ticket=TASK-2`);
	const previousReads = costReads;
	await page.clock.fastForward(300_000);
	await expect.poll(() => costReads).toBeGreaterThan(previousReads);
	await page.setViewportSize({ width: 1280, height: 900 });
	await expect(page.getByRole("img", { name: "other weekly remaining allowance from 100% to 0%" })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("legacy project Cost paths show the unknown-route view", async ({ page }) => {
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		(route) => route.fulfill({ status: 404, json: {} }),
	);
	await page.goto(`/repos/${projectId}/cost`);
	await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Repos", exact: true })).not.toHaveAttribute("aria-current");
	await expect(page).toHaveURL(`/repos/${projectId}/cost`);
});

test("Costs links open archived tickets outside the active board", async ({ page }) => {
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		(route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/api/costs") return route.fulfill({ json: cost });
			if (path === "/api/projects")
				return route.fulfill({ json: [{ id: projectId, name: "Forge", status: "ready", createdAt: since }] });
			if (path === "/api/accounts")
				return route.fulfill({
					json: {
						codex: { connection: "available", login: { state: "idle" } },
						github: { connection: "available", login: { state: "idle" } },
					},
				});
			if (path === "/api/tickets") return route.fulfill({ json: [] });
			if (path === "/api/epics") return route.fulfill({ json: [] });
			if (path === "/api/tickets/TASK-1")
				return route.fulfill({
					json: {
						id: "TASK-1",
						repositoryIds: [],
						title: "Cleanup",
						description: "Archived scope",
						status: "done",
						archivedAt: since,
						createdAt: since,
					},
				});
			if (path === "/api/tickets/TASK-1/workflow")
				return route.fulfill({
					json: { ticketId: "TASK-1", state: "idle", phase: "implementation", mergeAttempts: 0 },
				});
			return route.fulfill({ status: 404, json: {} });
		},
	);
	await page.goto("/costs");
	await page
		.getByRole("row", { name: /TASK-1 Cleanup/ })
		.getByRole("link")
		.click();
	await expect(page).toHaveURL(`/tasks?ticket=TASK-1`);
	const panel = page.getByRole("dialog", { name: "TASK-1" });
	await expect(panel).toBeVisible();
	await expect(panel.getByLabel("Description", { exact: true })).toHaveValue("Archived scope");
	await panel.getByRole("button", { name: "Close ticket" }).click();
	await page.goBack();
	await expect(panel).toBeVisible();
	await page.goBack();
	await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeVisible();
});
