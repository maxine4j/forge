import type { PipelineRun } from "@forge/contracts/pipelines";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { chooseDropdown, expectDropdownValue } from "./dropdown-helpers.ts";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const createdAt = "2026-11-12T00:00:00.000Z";
async function setup(page: Page) {
	let run: PipelineRun | undefined;
	let reads = 0;
	let failure = false;
	const source = {
		path: ".github/workflows/ci.yml",
		name: "CI",
		events: ["push", "workflow_dispatch"],
		messages: [],
	};
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const url = new URL(route.request().url());
			const path = url.pathname;
			if (path === "/api/projects")
				return route.fulfill({ json: [{ id: projectId, name: "Forge", status: "ready", createdAt }] });
			if (path === "/api/accounts")
				return route.fulfill({
					json: {
						codex: { connection: "available", login: { state: "idle" } },
						github: { connection: "available", login: { state: "idle" } },
					},
				});
			if (path.endsWith("/branches"))
				return route.fulfill({
					json: ["main", "feature", "empty", "invalid"].map((name) => ({ name, sha: "a".repeat(40) })),
				});
			if (path.endsWith("/pipelines")) {
				const branch = url.searchParams.get("branch");
				return route.fulfill({
					json: {
						commit: "a".repeat(40),
						workflows:
							branch === "empty"
								? []
								: branch === "invalid"
									? [{ ...source, messages: ["Unsupported runner"] }]
									: branch === "feature"
										? [{ ...source, name: "Feature", events: ["pull_request", "push"] }]
										: [
												source,
												{
													...source,
													path: ".github/workflows/review.yml",
													name: "Review",
													events: ["pull_request"],
												},
											],
					},
				});
			}
			if (path.endsWith("/pipeline-runs")) {
				if (route.request().method() === "POST") {
					if (failure) return route.fulfill({ status: 503, json: { error: "docker-unavailable" } });
					run = {
						...route.request().postDataJSON(),
						id: "123e4567-e89b-42d3-a456-426614174001",
						projectId,
						workflowName: "CI",
						commit: "a".repeat(40),
						state: "running",
						createdAt,
						startedAt: createdAt,
						finishedAt: null,
						failure: null,
						jobs: [
							{
								id: "test",
								name: "Tests",
								matrix: {},
								state: "running",
								startedAt: createdAt,
								finishedAt: null,
								steps: [
									{
										id: "first",
										name: "Check source",
										order: 0,
										phase: "Main",
										state: "running",
										startedAt: createdAt,
										finishedAt: null,
									},
								],
							},
						],
					};
					return route.fulfill({ status: 202, json: run });
				}
				const summary = run ? (({ jobs: _jobs, ...summary }) => summary)(run) : undefined;
				return route.fulfill({ json: { runs: summary ? [summary] : [], hasMore: false } });
			}
			if (path.includes("/pipeline-runs/")) {
				reads++;
				return route.fulfill({ json: run });
			}
			return route.fulfill({ status: 404, json: {} });
		},
	);
	return {
		reads: () => reads,
		fail: () => {
			failure = true;
		},
		complete: () => {
			if (!run) throw new Error();
			run.state = "succeeded";
			run.finishedAt = createdAt;
			run.jobs[0]!.state = "succeeded";
			run.jobs[0]!.steps[0]!.state = "failed";
		},
	};
}
test("branch-dependent workflows, default events, submission, live states, history and polling cleanup", async ({
	page,
}) => {
	const state = await setup(page);
	await page.goto(`/repos/${projectId}/pipelines`);
	await expectDropdownValue(page.getByRole("combobox", { name: "Event", exact: true }), "workflow_dispatch");
	await chooseDropdown(page.getByRole("combobox", { name: "Pipeline", exact: true }), ".github/workflows/review.yml");
	await expectDropdownValue(page.getByRole("combobox", { name: "Event", exact: true }), "pull_request");
	await chooseDropdown(page.getByRole("combobox", { name: "Pipeline", exact: true }), ".github/workflows/ci.yml");
	await expectDropdownValue(page.getByRole("combobox", { name: "Event", exact: true }), "workflow_dispatch");
	await chooseDropdown(page.getByRole("combobox", { name: "Branch", exact: true }), "feature");
	await expectDropdownValue(page.getByRole("combobox", { name: "Event", exact: true }), "push");
	await chooseDropdown(page.getByRole("combobox", { name: "Event", exact: true }), "pull_request");
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.getByRole("region", { name: "Selected pipeline run" })).toContainText("Check source");
	state.complete();
	await expect(page.getByRole("region", { name: "Selected pipeline run" })).toContainText("succeeded", {
		timeout: 6000,
	});
	await expect(page.getByRole("region", { name: "Selected pipeline run" })).toContainText("failed");
	const reads = state.reads();
	await page.waitForTimeout(2200);
	expect(state.reads()).toBe(reads);
	await page.reload();
	await expect(page.getByRole("region", { name: "Selected pipeline run" })).toContainText("succeeded");
	await page.getByRole("tab", { name: "Agents", exact: true }).click();
	const navigated = state.reads();
	await page.waitForTimeout(2200);
	expect(state.reads()).toBe(navigated);
});
test("empty, invalid and unavailable Docker states", async ({ page }) => {
	const state = await setup(page);
	await page.goto(`/repos/${projectId}/pipelines`);
	await chooseDropdown(page.getByRole("combobox", { name: "Branch", exact: true }), "empty");
	await expect(page.getByText("No workflows found", { exact: false })).toBeVisible();
	await chooseDropdown(page.getByRole("combobox", { name: "Branch", exact: true }), "invalid");
	await expect(page.getByText("Unsupported runner")).toBeVisible();
	await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
	await chooseDropdown(page.getByRole("combobox", { name: "Branch", exact: true }), "main");
	await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
	state.fail();
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("Docker is unavailable");
});

test("a newer history selection cancels an older failed read without a toast", async ({ page }) => {
	const state = await setup(page);
	await page.goto(`/repos/${projectId}/pipelines`);
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.getByRole("region", { name: "Selected pipeline run" })).toBeVisible();
	state.complete();
	await expect(page.getByRole("region", { name: "Selected pipeline run" })).toContainText("succeeded", {
		timeout: 6000,
	});
	const pending = Promise.withResolvers<void>();
	let reads = 0;
	await page.route("**/pipeline-runs/*", async (route) => {
		if (++reads !== 1) return route.fallback();
		await pending.promise;
		await route.fulfill({ status: 503, json: { error: "pipeline-unavailable" } });
	});
	const cancelled = page.waitForEvent("requestfailed", {
		predicate: (request) => request.url().includes("/pipeline-runs/"),
	});
	const history = page.getByRole("button", { name: /CI · main/ });
	await history.click();
	await expect.poll(() => reads).toBe(1);
	const loaded = page.waitForResponse(
		(response) => response.url().includes("/pipeline-runs/") && response.status() === 200,
	);
	try {
		await history.click();
		await loaded;
	} finally {
		pending.resolve();
	}
	await cancelled;
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByRole("region", { name: "Selected pipeline run" })).toContainText("succeeded");
});
