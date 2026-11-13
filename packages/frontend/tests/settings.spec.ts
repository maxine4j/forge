import { expect, test } from "@playwright/test";

import { chooseDropdown, expectDropdownValue } from "./dropdown-helpers.ts";

test("Config persists agent defaults, instructions and Git identity and can clear defaults offline", async ({
	page,
}) => {
	let settings = {
		localCurrency: "AUD",
		monthlyPlanLocal: 30,
		planningInstructions: "",
		implementationInstructions: "",
		gitName: "",
		gitEmail: "",
	};
	const updates: unknown[] = [];
	let catalogAvailable = true;
	await page.route("**/api/projects", (route) => route.fulfill({ json: [] }));
	await page.route("**/api/accounts", (route) =>
		route.fulfill({
			json: {
				codex: { connection: "available", login: { state: "idle" } },
				github: { connection: "available", login: { state: "idle" } },
			},
		}),
	);
	await page.route("**/api/settings", (route) => {
		if (route.request().method() === "PUT") {
			settings = route.request().postDataJSON();
			updates.push(settings);
		}
		return route.fulfill({ json: settings });
	});
	await page.route("**/api/settings/model-options", (route) =>
		catalogAvailable
			? route.fulfill({
					json: {
						models: [
							{
								id: "model-a",
								name: "Model A",
								isDefault: true,
								supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
							},
						],
						skills: [],
					},
				})
			: route.fulfill({ status: 503, json: { error: "settings-unavailable" } }),
	);
	await page.goto("/repos");
	await page.getByRole("link", { name: "Config", exact: true }).click();
	await expect(page).toHaveURL(/\/config$/u);
	await expect(page.getByRole("button", { name: "Refresh accounts" })).toBeVisible();
	await page.getByLabel("Planning instructions").fill("Check migrations.\nInclude rollback steps.");
	await page.getByLabel("Implementation instructions").fill("Run focused tests.");
	await page.getByLabel("Git name").fill("Forge Developer");
	await page.getByRole("button", { name: "Save settings" }).click();
	await expect(page.getByRole("alert")).toHaveText("Provide both a Git name and email, or leave both blank.");
	expect(updates).toEqual([]);
	await page.getByLabel("Git email").fill("forge@example.com");
	const currency = page
		.getByRole("group", { name: "Cost tracking" })
		.getByRole("combobox", { name: "Local currency", exact: true });
	await currency.click();
	await expect(page.getByRole("option", { name: "EUR", exact: true }).locator(".dropdown-icon")).toHaveText("🇪🇺");
	await currency.press("Escape");
	await currency.pressSequentially("eur");
	await expect(currency).toHaveText("🇦🇺AUD");
	await currency.press("Enter");
	await expect(currency).toHaveText("🇪🇺EUR");
	await page.getByLabel("Monthly plan price").fill("45.5");
	await chooseDropdown(page.getByRole("combobox", { name: "Default model", exact: true }), "model-a");
	await chooseDropdown(page.getByRole("combobox", { name: "Default thinking", exact: true }), "high");
	await page.getByRole("button", { name: "Save settings" }).click();
	await expect(page.getByRole("status")).toHaveText("Settings saved.");
	expect(updates).toEqual([
		{
			inferenceProvider: "openai",
			localCurrency: "EUR",
			monthlyPlanLocal: 45.5,
			planningInstructions: "Check migrations.\nInclude rollback steps.",
			implementationInstructions: "Run focused tests.",
			gitName: "Forge Developer",
			gitEmail: "forge@example.com",
			defaultAgentModel: "model-a",
			defaultAgentReasoningEffort: "high",
		},
	]);
	await page.reload();
	await expect(page.getByLabel("Planning instructions")).toHaveValue(settings.planningInstructions);
	await expect(page.getByLabel("Implementation instructions")).toHaveValue(settings.implementationInstructions);
	await expect(page.getByLabel("Git name")).toHaveValue(settings.gitName);
	await expectDropdownValue(page.getByRole("combobox", { name: "Local currency", exact: true }), "EUR");
	await expect(page.getByLabel("Monthly plan price")).toHaveValue("45.5");
	await expect(page.getByLabel("Git email")).toHaveValue(settings.gitEmail);
	await expectDropdownValue(page.getByRole("combobox", { name: "Default model", exact: true }), "model-a");
	await expectDropdownValue(page.getByRole("combobox", { name: "Default thinking", exact: true }), "high");
	catalogAvailable = false;
	await page.reload();
	await expect(page.getByRole("button", { name: "Retry loading models" })).toBeVisible();
	await chooseDropdown(page.getByRole("combobox", { name: "Default thinking", exact: true }), "");
	await chooseDropdown(page.getByRole("combobox", { name: "Default model", exact: true }), "");
	await page.getByRole("button", { name: "Save settings" }).click();
	await expect(page.getByRole("status")).toHaveText("Settings saved.");
	expect(updates.at(-1)).not.toHaveProperty("defaultAgentModel");
	expect(updates.at(-1)).not.toHaveProperty("defaultAgentReasoningEffort");
});

test("Config switches providers while preserving accounts and both providers' settings", async ({ page }) => {
	let settings = {
		inferenceProvider: "openai",
		localCurrency: "AUD",
		monthlyPlanLocal: 30,
		planningInstructions: "",
		implementationInstructions: "",
		gitName: "",
		gitEmail: "",
	};
	const updates: unknown[] = [];
	await page.route("**/api/projects", (route) => route.fulfill({ json: [] }));
	await page.route("**/api/accounts", (route) =>
		route.fulfill({
			json: {
				codex: { connection: "available", login: { state: "idle" } },
				github: { connection: "available", login: { state: "idle" } },
			},
		}),
	);
	await page.route("**/api/accounts/codex/login", (route) =>
		route.fulfill({
			json: {
				connection: "available",
				login: { state: "idle" },
			},
		}),
	);
	await page.route("**/api/settings/model-options", (route) => route.fulfill({ json: { models: [], skills: [] } }));
	await page.route("**/api/settings", (route) => {
		if (route.request().method() === "PUT") {
			settings = route.request().postDataJSON();
			updates.push(settings);
		}
		return route.fulfill({ json: settings });
	});
	await page.goto("/config");
	const upstream = page.getByRole("group", { name: "Version control upstream" });
	const inference = page.getByRole("group", { name: "Inference provider" });
	const provider = inference.getByRole("combobox", { name: "Provider for new agents", exact: true });
	const save = page.getByRole("button", { name: "Save settings" });
	await expect(
		upstream.getByRole("region", { name: "GitHub" }).getByRole("button", { name: "Sign in" }),
	).toBeVisible();
	await chooseDropdown(provider, "ollama");
	await save.click();
	await expect(page.getByRole("alert")).toHaveText("Provide an Ollama endpoint and model tag.");
	await inference.getByLabel("Ollama endpoint").fill("http://ollama.internal:11434/v1");
	await inference.getByLabel("Ollama model").fill("local-model:latest");
	const signIn = page.waitForRequest("**/api/accounts/codex/login");
	await inference.getByRole("region", { name: "ChatGPT" }).getByRole("button", { name: "Sign in" }).click();
	await signIn;
	expect(updates).toHaveLength(0);
	await save.click();
	await expect(page.getByRole("status")).toHaveText("Settings saved.");
	await chooseDropdown(provider, "openai");
	await save.click();
	await expect(page.getByRole("status")).toHaveText("Settings saved.");
	await page.reload();
	await expectDropdownValue(provider, "openai");
	await expect(inference.getByLabel("Ollama model")).toHaveValue("local-model:latest");
	await chooseDropdown(provider, "ollama");
	await save.click();
	await expect(page.getByRole("status")).toHaveText("Settings saved.");
	expect(updates).toHaveLength(3);
	expect(updates.at(-1)).toMatchObject({
		inferenceProvider: "ollama",
		ollamaEndpoint: "http://ollama.internal:11434/v1",
		ollamaModel: "local-model:latest",
	});
});
