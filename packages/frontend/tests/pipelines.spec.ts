import type { PipelineRun } from "@forge/contracts/pipelines";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

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
										: [source],
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
	await expect(page.getByRole("combobox", { name: "Event", exact: true })).toHaveValue("workflow_dispatch");
	await page.getByRole("combobox", { name: "Branch", exact: true }).selectOption("feature");
	await expect(page.getByRole("combobox", { name: "Event", exact: true })).toHaveValue("push");
	await page.getByRole("combobox", { name: "Event", exact: true }).selectOption("pull_request");
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
	await page.getByRole("combobox", { name: "Branch", exact: true }).selectOption("empty");
	await expect(page.getByText("No workflows found", { exact: false })).toBeVisible();
	await page.getByRole("combobox", { name: "Branch", exact: true }).selectOption("invalid");
	await expect(page.getByText("Unsupported runner")).toBeVisible();
	await expect(page.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
	await page.getByRole("combobox", { name: "Branch", exact: true }).selectOption("main");
	await expect(page.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
	state.fail();
	await page.getByRole("button", { name: "Run", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("Docker is unavailable");
});
