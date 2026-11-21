import type { TaskAgent, TaskAgentInput } from "@forge/contracts/task-agents";
import { defaultBoardSettings } from "@forge/contracts/tickets";
import { expect, test } from "@playwright/test";

const openai = "123e4567-e89b-42d3-a456-426614174000";
const ollama = "123e4567-e89b-42d3-a456-426614174001";
const id = "123e4567-e89b-42d3-a456-426614174002";

test("Tasks Agents adds, reorders, removes models and hides retired agents", async ({ page }) => {
	let agent: TaskAgent | undefined;
	const writes: TaskAgentInput[] = [];
	const modelReads: string[] = [];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const path = new URL(route.request().url()).pathname;
			const method = route.request().method();
			if (path === "/api/board/settings") return route.fulfill({ json: defaultBoardSettings });
			if (path === "/api/accounts") return route.fulfill({ status: 503, json: { error: "internal-error" } });
			if (path === "/api/task-agents" && method === "GET") return route.fulfill({ json: agent ? [agent] : [] });
			if (path === "/api/model-providers")
				return route.fulfill({
					json: [
						{ id: openai, name: "OpenAI", kind: "openai", retired: false },
						{ id: ollama, name: "Local", kind: "ollama", retired: false, endpoint: "http://ollama/v1" },
					],
				});
			if (path.endsWith("/model-options")) {
				modelReads.push(path);
				return route.fulfill({
					json: {
						models: [
							{
								id: "codex",
								name: "Codex",
								isDefault: true,
								defaultReasoningEffort: "medium",
								supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({
									reasoningEffort,
									description: reasoningEffort,
								})),
							},
						],
						skills: [],
					},
				});
			}
			if (path.startsWith("/api/task-agents") && (method === "POST" || method === "PATCH")) {
				const input = route.request().postDataJSON() as TaskAgentInput;
				writes.push(input);
				agent = { ...input, id, retired: false };
				return route.fulfill({ json: agent, status: method === "POST" ? 201 : 200 });
			}
			if (path === `/api/task-agents/${id}` && method === "DELETE" && agent) {
				agent = { ...agent, retired: true };
				return route.fulfill({ status: 204 });
			}
			return route.fulfill({ json: [] });
		},
	);
	await page.goto("/tasks");
	const tabs = page.getByRole("tablist", { name: "Task views" }).getByRole("tab");
	await expect(tabs).toHaveText(["Board", "Backlog", /Notifications/, "Agents"]);
	await tabs.first().press("End");
	await expect(page).toHaveURL("/tasks?view=agents");
	await page.reload();
	await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
	await page.getByRole("button", { name: "Add agent", exact: true }).click();
	await page.getByLabel("Name", { exact: true }).fill("Reviewer");
	await page.getByRole("combobox", { name: "Model provider", exact: true }).selectOption(openai);
	await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("codex");
	await expect(page.getByRole("option", { name: "Model default (medium)" })).toHaveCount(1);
	await page.getByRole("combobox", { name: "Thinking level", exact: true }).selectOption("high");
	await page.getByRole("button", { name: "Save agent" }).click();
	await expect(page.getByRole("heading", { name: "Reviewer", exact: true })).toBeVisible();
	const primary = { providerId: openai, model: "codex", reasoningEffort: "high" };
	expect(writes).toEqual([{ name: "Reviewer", models: [primary] }]);

	await page.getByRole("button", { name: "Edit Reviewer" }).click();
	await expect(page.getByRole("button", { name: "Remove model 1" })).toBeDisabled();
	await page.getByRole("button", { name: "Add model", exact: true }).click();
	await page.getByRole("group", { name: "Model 2", exact: true }).getByLabel("Model provider").selectOption(ollama);
	await page.getByLabel("Model tag").fill("local:latest");
	await page.getByRole("button", { name: "Move model 2 up" }).click();
	await page.getByRole("button", { name: "Save agent" }).click();
	await expect(page.getByText("Local · local:latest")).toBeVisible();
	const local = { providerId: ollama, model: "local:latest" };
	expect(writes.at(-1)).toEqual({ name: "Reviewer", models: [local, primary] });
	await page.getByRole("button", { name: "Edit Reviewer" }).click();
	await page.getByRole("button", { name: "Remove model 2" }).click();
	await page.getByRole("button", { name: "Save agent" }).click();
	await expect(page.getByRole("button", { name: "Edit Reviewer" })).toBeEnabled();
	expect(writes.at(-1)).toEqual({ name: "Reviewer", models: [local] });
	expect([...new Set(modelReads)]).toEqual([`/api/model-providers/${openai}/model-options`]);

	await page.getByRole("button", { name: "Retire Reviewer" }).click();
	await page.getByRole("button", { name: "Retire agent", exact: true }).click();
	await expect(page.getByText("No agents configured.")).toBeVisible();
	await expect(page.getByRole("heading", { name: /Reviewer/ })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Edit Reviewer" })).toHaveCount(0);
	await page.goto(`/repos/${openai}/agents`);
	await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
