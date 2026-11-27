import type { TaskAgent, TaskAgentInput } from "@forge/contracts/task-agents";
import { defaultBoardSettings } from "@forge/contracts/tickets";
import { expect, test } from "@playwright/test";

import { MockApi } from "../dev/mock-api.ts";

const openai = "123e4567-e89b-42d3-a456-426614174000";
const ollama = "123e4567-e89b-42d3-a456-426614174001";
const id = "123e4567-e89b-42d3-a456-426614174002";
const unused = "123e4567-e89b-42d3-a456-426614174003";

test("Tasks Agents manages models and avatar colours and shows the assignee on tickets", async ({ page }) => {
	let agent: TaskAgent | undefined;
	const writes: TaskAgentInput[] = [];
	const modelReads: string[] = [];
	let healthReads = 0;
	let schedulerReads = 0;
	let usageFails = false;
	let schedulerFails = false;
	let sparse = false;
	const costs = new MockApi().read(new URL("http://localhost/api/costs?range=-7d")) as {
		providers: Array<{ id: string; incompleteTokens: number }>;
	};
	costs.providers[0]!.id = openai;
	costs.providers[0]!.incompleteTokens = 1;
	costs.providers[1]!.id = ollama;
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const path = new URL(route.request().url()).pathname;
			const method = route.request().method();
			if (path === "/api/costs")
				return usageFails ? route.fulfill({ status: 503 }) : route.fulfill({ json: costs });
			if (path === "/api/tickets/agent-metrics") {
				schedulerReads++;
				return schedulerFails
					? route.fulfill({ status: 503 })
					: route.fulfill({
							json: {
								providers: sparse ? [] : [{ providerId: openai, running: 2, reserved: 3 }],
								agents: [{ agentId: id, queued: 4 }],
							},
						});
			}
			if (path === "/api/board/settings") return route.fulfill({ json: defaultBoardSettings });
			if (path === "/api/accounts") return route.fulfill({ status: 503, json: { error: "internal-error" } });
			if (path === "/api/tickets" && agent) {
				const assignee = {
					name: agent.name,
					avatarColour: agent.avatarColour,
					avatarSymbol: agent.avatarSymbol,
				};
				const ticket = { repositoryIds: [], description: "", createdAt: "2026-11-03T00:00:00.000Z" };
				return route.fulfill({
					json: [
						{ ...ticket, id: "TASK-1", title: "Assigned", status: "backlog", assignee },
						{
							...ticket,
							id: "TASK-2",
							title: "Active",
							status: "in-progress",
							agentStatus: "working",
							assignee,
						},
						{ ...ticket, id: "TASK-3", title: "Unassigned", status: "backlog" },
					],
				});
			}
			if (path === "/api/task-agents" && method === "GET") return route.fulfill({ json: agent ? [agent] : [] });
			if (path === "/api/model-providers/health") {
				healthReads++;
				if (healthReads === 3) return route.fulfill({ status: 503 });
				return route.fulfill({
					json: [
						{ providerId: openai, status: "healthy" },
						{ providerId: ollama, status: "unhealthy" },
						{ providerId: unused, status: "usage-limits-reached" },
					],
				});
			}
			if (path === "/api/model-providers")
				return route.fulfill({
					json: [
						{ id: openai, name: "OpenAI", kind: "openai", retired: false },
						{ id: ollama, name: "Local", kind: "ollama", retired: false, endpoint: "http://ollama/v1" },
						{
							id: unused,
							name: `Unused ${"long-provider-name-".repeat(5)}`,
							kind: "ollama",
							retired: false,
							endpoint: `http://${"long-endpoint-".repeat(12)}example/v1`,
						},
						{ id: "123e4567-e89b-42d3-a456-426614174004", name: "Retired", kind: "openai", retired: true },
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
				agent = {
					...input,
					id,
					retired: false,
					maxConcurrentTickets: input.maxConcurrentTickets === undefined ? 1 : input.maxConcurrentTickets,
					avatarColour: input.avatarColour ?? agent?.avatarColour ?? "Sky",
					avatarSymbol: input.avatarSymbol ?? agent?.avatarSymbol ?? "Robot",
				};
				return route.fulfill({ json: agent, status: method === "POST" ? 201 : 200 });
			}
			if (path === `/api/task-agents/${id}` && method === "DELETE" && agent) {
				agent = { ...agent, retired: true };
				return route.fulfill({ status: 204 });
			}
			return route.fulfill({ json: [] });
		},
	);
	await page.clock.install();
	await page.goto("/tasks");
	const tabs = page.getByRole("tablist", { name: "Task views" }).getByRole("tab");
	await expect(tabs).toHaveText(["Board", "Backlog", /Notifications/, "Agents"]);
	await tabs.first().press("End");
	await expect(page).toHaveURL("/tasks?view=agents");
	const health = page.getByRole("region", { name: "Model providers" });
	await expect(health).toContainText("Healthy");
	await expect(health).toContainText("Unhealthy");
	await expect(health).toContainText("Usage limits reached");
	await expect(health).toContainText("Unused");
	await expect(health).not.toContainText("Retired");
	await expect(health).toContainText("Running 2 / 1");
	await expect(health).toContainText("3 slots reserved");
	await expect(health).toContainText("Token usage is incomplete");
	await expect(health).toContainText("No recorded usage");
	const healthBeforePoll = healthReads;
	const schedulerBeforePoll = schedulerReads;
	await page.clock.fastForward(10_000);
	await expect.poll(() => schedulerReads).toBeGreaterThan(schedulerBeforePoll);
	expect(healthReads).toBe(healthBeforePoll);
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, value: true });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	const schedulerWhileHidden = schedulerReads;
	await page.clock.fastForward(10_000);
	expect(schedulerReads).toBe(schedulerWhileHidden);
	await page.evaluate(() => {
		Object.defineProperty(document, "hidden", { configurable: true, value: false });
		document.dispatchEvent(new Event("visibilitychange"));
	});
	await expect.poll(() => schedulerReads).toBeGreaterThan(schedulerWhileHidden);
	for (const [width, columns] of [
		[1280, 3],
		[820, 2],
		[390, 1],
	] as const) {
		await page.setViewportSize({ width, height: 900 });
		const grid = page.locator(".provider-metrics-grid");
		expect(await grid.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(
			columns,
		);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
		await health.getByRole("button", { name: "Refresh metrics" }).focus();
		await expect(health.getByRole("button", { name: "Refresh metrics" })).toBeFocused();
	}
	await page.setViewportSize({ width: 1280, height: 900 });
	await health.getByRole("button", { name: "Refresh metrics" }).click();
	await expect(health).toContainText("Stale");
	await expect(
		page.getByRole("group", { name: "Agent actions" }).getByRole("button", { name: "Create agent" }),
	).toBeEnabled();
	await health.getByRole("button", { name: "Refresh metrics" }).click();
	await expect(health).toContainText("Healthy");
	usageFails = true;
	schedulerFails = true;
	await health.getByRole("button", { name: "Refresh metrics" }).click();
	await expect(health.getByText("Running 2 / 1 (Stale)")).toBeVisible();
	await expect(health.getByText("Last 7 days (Stale)").first()).toBeVisible();
	usageFails = false;
	schedulerFails = false;
	sparse = true;
	await health.getByRole("button", { name: "Refresh metrics" }).click();
	await expect(health.getByText("Running 0 / 1").first()).toBeVisible();
	sparse = false;
	await page.reload();
	await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
	await page.getByRole("group", { name: "Agent actions" }).getByRole("button", { name: "Create agent" }).click();
	await page.getByLabel("Name", { exact: true }).fill("Reviewer");
	await page.getByRole("combobox", { name: "Model provider", exact: true }).selectOption(openai);
	await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("codex");
	await expect(page.getByRole("option", { name: "Model default (medium)" })).toHaveCount(1);
	await page.getByRole("combobox", { name: "Thinking level", exact: true }).selectOption("high");
	await page.getByRole("button", { name: "Save agent" }).click();
	await expect(page.getByRole("heading", { name: "Reviewer", exact: true })).toBeVisible();
	await expect(page.getByText("4 in queue")).toBeVisible();
	await expect(page.getByRole("heading", { name: "Reviewer", exact: true }).locator(".agent-avatar")).toHaveAttribute(
		"data-colour",
		"Sky",
	);
	await expect(page.getByText("OpenAI · codex · high")).toBeVisible();
	await expect(page.getByRole("button", { name: "Save agent" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Add model" })).toHaveCount(0);
	await page.getByRole("button", { name: "Edit Reviewer" }).click();
	await expect(page.getByRole("dialog", { name: "Edit Reviewer" })).toBeVisible();
	const primary = { providerId: openai, model: "codex", reasoningEffort: "high" };
	expect(writes).toEqual([{ name: "Reviewer", models: [primary], maxConcurrentTickets: 1 }]);
	const colours = page.getByRole("group", { name: "Avatar colour" });
	await expect(colours.getByRole("radio")).toHaveCount(12);
	const contrasts = await colours.locator(".agent-avatar").evaluateAll((avatars) => {
		const luminance = (colour: string) => {
			const channels = colour
				.match(/\d+/g)!
				.slice(0, 3)
				.map((value) => Number(value) / 255)
				.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
			return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
		};
		return avatars.map((avatar) => {
			const background = luminance(getComputedStyle(avatar).backgroundColor);
			const foreground = luminance(getComputedStyle(avatar.querySelector(".agent-avatar-head")!).color);
			return (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05);
		});
	});
	expect(Math.min(...contrasts)).toBeGreaterThanOrEqual(4.5);
	await expect(colours.getByRole("radio", { name: "Sky" })).toBeChecked();
	await colours.getByTitle("Mint").click();
	await expect(colours.getByRole("radio", { name: "Mint" })).toBeChecked();
	const symbols = page.getByRole("group", { name: "Avatar symbol" });
	await expect(symbols.getByRole("radio", { name: "Robot" })).toBeChecked();
	await symbols.getByTitle("Apple").click();
	await expect(symbols.getByRole("radio", { name: "Apple" })).toBeChecked();
	await expect(page.getByRole("slider", { name: "Max concurrent tickets" })).toHaveAttribute("aria-valuetext", "1");
	await page.getByRole("slider", { name: "Max concurrent tickets" }).press("End");
	await expect(page.getByRole("slider", { name: "Max concurrent tickets" })).toHaveAttribute(
		"aria-valuetext",
		"Unlimited",
	);
	await page.getByRole("slider", { name: "Max concurrent tickets" }).press("Home");
	await page.getByRole("slider", { name: "Max concurrent tickets" }).press("ArrowRight");

	await page.getByRole("button", { name: "Edit title: Reviewer" }).click();
	await page.getByLabel("Title", { exact: true }).fill("Reviewer updated");
	await page.getByRole("button", { name: "Save title" }).click();
	await expect(page.getByRole("button", { name: "Edit title: Reviewer updated" })).toBeVisible();
	expect(writes.at(-1)).toEqual({ name: "Reviewer updated", models: [primary], maxConcurrentTickets: 1 });
	await expect(page.getByLabel("Max concurrent tickets")).toHaveAttribute("aria-valuetext", "2");
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
	await expect(page.getByText("Local · local:latest")).toBeVisible();
	await expect(page.getByRole("button", { name: "Save agent" })).toHaveCount(0);
	const local = { providerId: ollama, model: "local:latest" };
	expect(writes.at(-1)).toEqual({
		name: "Reviewer updated",
		models: [local, primary],
		maxConcurrentTickets: 2,
		avatarColour: "Mint",
		avatarSymbol: "Apple",
	});
	await page.getByRole("button", { name: "Edit Reviewer updated" }).click();
	await expect(page.getByLabel("Max concurrent tickets")).toHaveAttribute("aria-valuetext", "2");
	await colours.getByTitle("Amber").click();
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await page.getByRole("button", { name: "Discard changes" }).click();
	await expect(page.getByText("OpenAI · codex · high")).toBeVisible();
	await page.getByRole("button", { name: "Edit Reviewer updated" }).click();
	await expect(colours.getByRole("radio", { name: "Mint" })).toBeChecked();
	await expect(symbols.getByRole("radio", { name: "Apple" })).toBeChecked();
	await expect(page.getByLabel("Max concurrent tickets")).toHaveAttribute("aria-valuetext", "2");
	await page.getByRole("slider", { name: "Max concurrent tickets" }).press("End");
	await page.getByRole("button", { name: "Remove model 2" }).click();
	await page.getByRole("button", { name: "Save agent" }).click();
	await expect(page.getByRole("button", { name: "Archive Reviewer updated" })).toBeEnabled();
	expect(writes.at(-1)).toEqual({
		name: "Reviewer updated",
		models: [local],
		maxConcurrentTickets: null,
		avatarColour: "Mint",
		avatarSymbol: "Apple",
	});
	expect([...new Set(modelReads)]).toEqual([`/api/model-providers/${openai}/model-options`]);

	await page.getByRole("tab", { name: "Board", exact: true }).click();
	await expect(page.locator(".provider-metrics-grid")).toHaveCount(0);
	await page.waitForTimeout(100);
	const schedulerAfterLeave = schedulerReads;
	await page.clock.fastForward(10_000);
	expect(schedulerReads).toBe(schedulerAfterLeave);
	const assigned = page.getByRole("button", { name: "TASK-1 Assigned" });
	await expect(assigned.getByRole("img", { name: "Reviewer updated" })).toHaveAttribute("data-colour", "Mint");
	await expect(assigned.getByRole("img", { name: "Reviewer updated" })).toHaveAttribute("data-symbol", "Apple");
	const active = page.getByRole("button", { name: "TASK-2 Active" });
	await expect(active.getByRole("img", { name: "Agent working" })).toBeVisible();
	await expect(active.locator(".ticket-agent-status + .agent-avatar")).toHaveAttribute("data-colour", "Mint");
	await expect(active.getByRole("img", { name: "Reviewer updated" })).toHaveCSS(
		"background-color",
		"rgb(131, 223, 168)",
	);
	await page.setViewportSize({ width: 390, height: 844 });
	const indicators = (await active.locator(".ticket-indicators").boundingBox())!;
	const key = (await active.locator(".ticket-key").boundingBox())!;
	expect(key.x + key.width).toBeLessThan(indicators.x);
	await expect(page.getByRole("button", { name: "TASK-3 Unassigned" }).locator(".agent-avatar")).toHaveCount(0);
	await page.getByRole("tab", { name: "Backlog", exact: true }).click();
	await expect(
		page.getByRole("row").filter({ hasText: "TASK-1" }).getByRole("img", { name: "Reviewer updated" }),
	).toHaveAttribute("data-colour", "Mint");
	await page.getByRole("tab", { name: "Agents", exact: true }).click();

	await page.getByRole("button", { name: "Archive Reviewer updated" }).click();
	await page.getByRole("button", { name: "Archive agent", exact: true }).click();
	await expect(page.getByText("No agents configured.")).toBeVisible();
	await expect(page.getByRole("heading", { name: /Reviewer/ })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Edit Reviewer" })).toHaveCount(0);
	await page.goto(`/repos/${openai}/agents`);
	await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
