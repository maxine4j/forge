import { expect, test } from "@playwright/test";

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
	const currency = page.getByRole("group", { name: "Cost tracking" }).getByLabel("Local currency");
	await expect(currency.locator('option[value="EUR"]')).toHaveText("🇪🇺 EUR");
	await currency.selectOption("EUR");
	await page.getByLabel("Monthly plan price").fill("45.5");
	await page.getByLabel("Default model").selectOption("model-a");
	await page.getByLabel("Default thinking").selectOption("high");
	await page.getByRole("button", { name: "Save settings" }).click();
	await expect(page.getByRole("status")).toHaveText("Settings saved.");
	expect(updates).toEqual([
		{
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
	await expect(page.getByLabel("Local currency")).toHaveValue("EUR");
	await expect(page.getByLabel("Monthly plan price")).toHaveValue("45.5");
	await expect(page.getByLabel("Git email")).toHaveValue(settings.gitEmail);
	await expect(page.getByLabel("Default model")).toHaveValue("model-a");
	await expect(page.getByLabel("Default thinking")).toHaveValue("high");
	catalogAvailable = false;
	await page.reload();
	await expect(page.getByRole("button", { name: "Retry loading models" })).toBeVisible();
	await page.getByLabel("Default thinking").selectOption("");
	await page.getByLabel("Default model").selectOption("");
	await page.getByRole("button", { name: "Save settings" }).click();
	await expect(page.getByRole("status")).toHaveText("Settings saved.");
	expect(updates.at(-1)).not.toHaveProperty("defaultAgentModel");
	expect(updates.at(-1)).not.toHaveProperty("defaultAgentReasoningEffort");
});
