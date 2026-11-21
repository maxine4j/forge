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
	await page.getByRole("group", { name: "Agent actions" }).getByRole("button", { name: "Create agent" }).click();
	await page.getByLabel("Name", { exact: true }).fill("Reviewer");
	await page.getByRole("combobox", { name: "Model provider", exact: true }).selectOption(openai);
	await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("codex");
	await expect(page.getByRole("option", { name: "Model default (medium)" })).toHaveCount(1);
	await page.getByRole("combobox", { name: "Thinking level", exact: true }).selectOption("high");
	await page.getByRole("button", { name: "Save agent" }).click();
	await expect(page.getByRole("button", { name: "Edit title: Reviewer" })).toBeVisible();
	const primary = { providerId: openai, model: "codex", reasoningEffort: "high" };
	expect(writes).toEqual([{ name: "Reviewer", models: [primary] }]);

	await page.getByRole("button", { name: "Edit title: Reviewer" }).click();
	await page.getByLabel("Title", { exact: true }).fill("Reviewer updated");
	await page.getByRole("button", { name: "Save title" }).click();
	await expect(page.getByRole("button", { name: "Edit title: Reviewer updated" })).toBeVisible();
	expect(writes.at(-1)).toEqual({ name: "Reviewer updated", models: [primary] });
	await expect(page.getByRole("button", { name: "Remove model 1" })).toBeDisabled();
	await expect(page.getByRole("button", { name: /Move model/ })).toHaveCount(0);
	await page.getByRole("button", { name: "Add model", exact: true }).click();
	await expect(page.getByText("Model 1", { exact: true })).toHaveCount(0);
	await page.getByRole("group", { name: "Model 2", exact: true }).getByLabel("Model provider").selectOption(ollama);
	await page.getByLabel("Model tag").fill("local:latest");
	for (const index of [1, 2]) {
		const row = page.getByRole("group", { name: `Model ${index}`, exact: true });
		const bounds = await row.locator("button, select, input").evaluateAll((elements) =>
			elements.map((element) => ({
				top: element.getBoundingClientRect().top,
				height: element.getBoundingClientRect().height,
			})),
		);
		for (const bound of bounds) {
			expect(Math.abs(bound.top - bounds[0]!.top)).toBeLessThan(1);
			expect(Math.abs(bound.height - bounds[0]!.height)).toBeLessThan(1);
		}
	}
	const source = (await page.getByRole("button", { name: "Drag model 2" }).boundingBox())!;
	const target = (await page.getByRole("group", { name: "Model 1", exact: true }).boundingBox())!;
	await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
	await page.mouse.down();
	await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
	await expect(page.getByRole("group", { name: "Model 1", exact: true }).getByLabel("Model tag")).toHaveValue(
		"local:latest",
	);
	await page.keyboard.press("Escape");
	await page.mouse.up();
	await expect(page.getByRole("group", { name: "Model 2", exact: true }).getByLabel("Model tag")).toHaveValue(
		"local:latest",
	);
	await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
	await page.mouse.down();
	await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
	await expect(page.getByRole("group", { name: "Model 1", exact: true }).getByLabel("Model tag")).toHaveValue(
		"local:latest",
	);
	await page.mouse.up();
	const firstHandle = (await page.getByRole("button", { name: "Drag model 1" }).boundingBox())!;
	const secondRow = (await page.getByRole("group", { name: "Model 2", exact: true }).boundingBox())!;
	await page.mouse.move(firstHandle.x + firstHandle.width / 2, firstHandle.y + firstHandle.height / 2);
	await page.mouse.down();
	await page.mouse.move(secondRow.x + secondRow.width / 2, secondRow.y + secondRow.height / 2, { steps: 10 });
	await expect(page.getByRole("group", { name: "Model 2" }).getByLabel("Model tag")).toHaveValue("local:latest");
	await page.mouse.up();
	await page.getByRole("button", { name: "Drag model 2" }).press("ArrowUp");
	await page.getByRole("button", { name: "Save agent" }).click();
	await expect(page.getByLabel("Model tag")).toHaveValue("local:latest");
	const local = { providerId: ollama, model: "local:latest" };
	expect(writes.at(-1)).toEqual({ name: "Reviewer updated", models: [local, primary] });
	await page.getByRole("button", { name: "Remove model 2" }).click();
	await page.getByRole("button", { name: "Save agent" }).click();
	await expect(page.getByRole("button", { name: "Archive Reviewer updated" })).toBeEnabled();
	expect(writes.at(-1)).toEqual({ name: "Reviewer updated", models: [local] });
	expect([...new Set(modelReads)]).toEqual([`/api/model-providers/${openai}/model-options`]);

	await page.getByRole("button", { name: "Archive Reviewer updated" }).click();
	await page.getByRole("button", { name: "Archive agent", exact: true }).click();
	await expect(page.getByText("No agents configured.")).toBeVisible();
	await expect(page.getByRole("heading", { name: /Reviewer/ })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Edit Reviewer" })).toHaveCount(0);
	await page.goto(`/repos/${openai}/agents`);
	await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
