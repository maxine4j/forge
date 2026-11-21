import { expect, test } from "@playwright/test";

import { costFixture, phaseFixtures } from "../dev/cost-fixture.ts";
import { chooseDropdown } from "./dropdown-helpers.ts";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const since = "2026-11-03T00:00:00.000Z";
const tokens = costFixture({ input: 1800, cached: 600, output: 200, turns: 2 }, 0.0625, 0.123456, 0.015 / 1.44);
tokens.incomplete.api = 1;
const emptyProvider = { input: 0, cached: 0, output: 0, turns: 0, apiAud: 0, incomplete: 0, incompleteTokens: 0 };
const openai = { ...emptyProvider, input: 1400, cached: 450, output: 100, turns: 1, apiAud: 0.125, incomplete: 1 };
const ollama = {
	...emptyProvider,
	input: 400,
	cached: 150,
	output: 100,
	turns: 1,
	apiAud: 0.2456,
	weeklySavedPercent: 1.234,
	incompleteWeekly: 0,
};
const cost = {
	providerTotals: { openai, ollama },
	providers: [
		{ id: "cloud", name: "OpenAI Primary", kind: "openai", current: true, workSharePercent: 75, ...openai },
		{ id: "local", name: "Local Ollama", kind: "ollama", workSharePercent: 25, ...ollama },
	],
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
	chats: costFixture({ input: 0, cached: 0, output: 0, turns: 0 }),
	quotaAttribution: [],
	totals: tokens,
	ticketEstimates: tokens,
	phases: [
		{ phase: "review", ...tokens },
		{ phase: "chat", ...tokens },
	],
	days: [{ date: "2026-11-10", input: 1800, cached: 600, output: 200 }],
	tickets: [
		{
			id: "TASK-2",
			title: "Search",
			...tokens,
			phases: phaseFixtures(tokens),
		},
		{
			id: "TASK-1",
			title: "Cleanup",
			archivedAt: since,
			...costFixture({ input: 0, cached: 0, output: 0, turns: 0 }),
			phases: [],
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
	let requestedRange: string | null = null;
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
				requestedRange = new URL(route.request().url()).searchParams.get("range");
				if (unavailable) return route.fulfill({ status: 503, json: {} });
				if (requestedRange === "-1hr") {
					const empty = costFixture({ input: 0, cached: 0, output: 0, turns: 0 });
					return route.fulfill({
						json: {
							...cost,
							totals: empty,
							ticketEstimates: empty,
							days: [],
							hours: [],
							providerTotals: {
								openai: emptyProvider,
								ollama: { ...emptyProvider, weeklySavedPercent: 0, incompleteWeekly: 0 },
							},
							providers: cost.providers.map((provider) => ({
								...provider,
								...emptyProvider,
								workSharePercent: 0,
								weeklySavedPercent: 0,
							})),
						},
					});
				}
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
	const openai = page.getByRole("region", { name: "OpenAI", exact: true });
	await expect(openai.getByText("AUD $0.13", { exact: true })).toBeVisible();
	await expect(openai.getByText("33%", { exact: true })).toBeVisible();
	const ollamaCard = page.getByRole("region", { name: "Ollama", exact: true });
	await expect(ollamaCard).toContainText("AUD $0.25");
	await expect(ollamaCard).toContainText("1.23%");
	const providerTable = page.getByRole("region", { name: "Provider costs" });
	await expect(providerTable.getByRole("row", { name: /OpenAI Primary/ })).toContainText("75.0%");
	const localRow = providerTable.getByRole("row", { name: /Local Ollama/ });
	await expect(localRow.getByRole("cell")).toHaveText(["400", "150", "100", "25.0%", "AUD $0.25", "1.23%"]);
	await expect(page.getByText("Account usage including standalone chats")).toHaveCount(0);
	await expect(page.getByText("Standalone chats", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Recorded timestamp and remaining allowance")).toHaveCount(0);
	await expect(page.getByText(/Account-wide budget capacity/)).toHaveCount(0);
	const tokenChart = page.getByRole("application", { name: "Daily token usage" });
	await expect(tokenChart).toBeVisible();
	await tokenChart.press("ArrowRight");
	await expect(page.getByText("Cached input : 600")).toBeVisible();
	const period = page.getByRole("combobox", { name: "Cost time range", exact: true });
	await expect(period).toHaveText("-7d");
	expect(requestedRange).toBe("-7d");
	await chooseDropdown(period, "-1hr");
	await expect(page.getByText("No tokens recorded in this period.")).toBeVisible();
	await expect(localRow).toContainText("0.0%");
	await expect(page.getByRole("link", { name: "TASK-2 Search" })).toHaveAttribute(
		"href",
		"/costs?range=-1hr&ticket=TASK-2",
	);
	expect(requestedRange).toBe("-1hr");
	await chooseDropdown(period, "custom");
	const custom = page.getByRole("textbox", { name: "Custom range" });
	await custom.fill("-2.5d");
	await page.getByRole("button", { name: "Apply" }).click();
	await expect(page.getByText("Enter a range such as -14d or -12hr.")).toBeVisible();
	await custom.fill("-35d");
	await custom.press("Enter");
	await expect(page).toHaveURL("/costs?range=-35d");
	await expect(tokenChart).toBeVisible();
	expect(requestedRange).toBe("-35d");
	await chooseDropdown(period, "-7d");
	const codexChart = page.getByRole("application", { name: "codex weekly remaining allowance from 100% to 0%" });
	await expect(codexChart).toBeVisible();
	await codexChart.press("ArrowRight");
	await expect(page.getByText("Remaining allowance : 40%")).toBeVisible();
	await expect(page.getByText(/Estimated additional tickets:.*≈ 8/)).toBeVisible();
	await chooseDropdown(page.getByRole("combobox", { name: "Weekly bucket", exact: true }), "other");
	const otherChart = page.getByRole("application", { name: "other weekly remaining allowance from 100% to 0%" });
	await expect(otherChart).toBeVisible();
	cost.weeklyBudget.buckets[1]!.additionalTickets = undefined;
	Object.assign(cost.weeklyBudget.buckets[1]!, { unavailable: "learning" });
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(page.getByText(/Estimated additional tickets:.*Learning usage pattern/)).toBeVisible();
	Object.assign(cost.weeklyBudget.buckets[1]!, { unavailable: "stale", fresh: false });
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(page.getByText(/Unavailable: latest observation/)).toBeVisible();
	await expect(page.getByRole("img", { name: "Ticket tokens by phase" })).toContainText("Review");
	await expect(page.getByText("5-hour window")).toBeVisible();
	await expect(page.getByText("Weekly window")).toBeVisible();
	const ticket = page.getByRole("row", { name: /TASK-2 Search/ });
	await expect(ticket).toContainText("$0.015");
	await expect(ticket).toContainText("$0.09");
	await expect(ticket).toContainText("1 turn missing pricing or usage");
	await expect(page.getByRole("row", { name: /TASK-1 Cleanup/ })).toContainText("Archived");
	await expect(ticket).toContainText("0.123%");
	await chooseDropdown(page.getByRole("combobox", { name: "Sort tickets", exact: true }), "ticket");
	await expect(page.getByRole("region", { name: "Ticket costs" }).getByRole("row").nth(1)).toContainText("TASK-1");
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await expect(ticket.getByRole("link")).toHaveAttribute("href", `/costs?ticket=TASK-2`);
	const previousReads = costReads;
	await page.clock.fastForward(300_000);
	await expect.poll(() => costReads).toBeGreaterThan(previousReads);
	await page.setViewportSize({ width: 1280, height: 900 });
	await expect(otherChart).toBeVisible();
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
	let ticketRange: string | null = null;
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
			if (path === "/api/tickets/TASK-1/cost") {
				ticketRange = new URL(route.request().url()).searchParams.get("range");
				return route.fulfill({ json: { since, ticket: cost.tickets[1], phases: [] } });
			}
			return route.fulfill({ status: 404, json: {} });
		},
	);
	await page.goto("/costs?range=-12hr");
	await page
		.getByRole("row", { name: /TASK-1 Cleanup/ })
		.getByRole("link")
		.click();
	await expect(page).toHaveURL(/\/costs\?range=-12hr&ticket=TASK-1(?:&tab=details)?$/);
	const panel = page.getByRole("dialog", { name: "TASK-1" });
	await expect(panel).toBeVisible();
	await expect(panel.getByText("Archived scope", { exact: true })).toBeVisible();
	await panel.getByRole("tab", { name: "Cost" }).click();
	await expect(panel.getByText("No usage recorded for this ticket in this period.")).toBeVisible();
	expect(ticketRange).toBe("-12hr");
	await panel.getByRole("button", { name: "Close ticket" }).click();
	await expect(panel).toHaveCount(0);
	await expect(page).toHaveURL("/costs?range=-12hr");
	await expect(page.getByRole("heading", { name: "Costs", exact: true })).toBeVisible();
	await page.goForward();
	await expect(panel).toBeVisible();
	await page.goBack();
	await expect(page).toHaveURL("/costs?range=-12hr");
	await expect(panel).toHaveCount(0);
});
