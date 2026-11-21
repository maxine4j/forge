import type { ModelProvider } from "@forge/contracts/model-providers";
import { defaultForgeSettings } from "@forge/contracts/settings";
import { expect, test, type Page } from "@playwright/test";

import { chooseDropdown } from "./dropdown-helpers.ts";

async function setup(page: Page, verified = false) {
	let settings = { ...defaultForgeSettings };
	const providers: ModelProvider[] = [];
	const writes: unknown[] = [];
	let loginRequests = 0;
	let login: Record<string, unknown> = verified
		? { connection: "available", account: { name: "owner@example.test" }, login: { state: "completed" } }
		: { connection: "available", login: { state: "idle" } };
	await page.route("**/api/projects", (route) => route.fulfill({ json: [] }));
	await page.route("**/api/settings", (route) => {
		if (route.request().method() === "PUT") settings = route.request().postDataJSON();
		return route.fulfill({ json: settings });
	});
	await page.route("**/api/accounts", (route) =>
		route.fulfill({ json: { codex: login, github: { connection: "available", login: { state: "idle" } } } }),
	);
	await page.route("**/api/accounts/codex/*", (route) => {
		loginRequests++;
		expect(providers).toHaveLength(1);
		login = route.request().url().endsWith("cancel")
			? { connection: "available", login: { state: "cancelled" } }
			: {
					connection: "available",
					login: {
						state: "pending",
						verificationUrl: "https://auth.openai.com/codex/device",
						userCode: "ABCD-1234",
					},
				};
		return route.fulfill({ json: login });
	});
	await page.route("**/api/model-providers{,/**}", (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		const provider = providers.find((p) => path.includes(p.id));
		if (path.endsWith("model-options"))
			return route.fulfill({
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
			});
		if (request.method() === "POST") {
			const input = request.postDataJSON();
			const value = {
				...input,
				id: `123e4567-e89b-42d3-a456-${String(426614174001 + providers.length)}`,
				retired: false,
			};
			providers.push(value);
			writes.push(input);
			return route.fulfill({ status: 201, json: value });
		}
		if (request.method() === "PATCH" && provider) {
			const input = request.postDataJSON();
			writes.push(input);
			Object.assign(provider, input);
			if (provider.compactionThresholdTokens === null) delete provider.compactionThresholdTokens;
			return route.fulfill({ json: provider });
		}
		if (request.method() === "DELETE" && provider) {
			provider.retired = true;
			return route.fulfill({ status: 204 });
		}
		return route.fulfill({ json: providers.filter((p) => !p.retired) });
	});
	await page.goto("/config");
	return { providers, writes, settings: () => settings, loginRequests: () => loginRequests };
}

test("a replacement OpenAI provider reuses a verified account without starting another login", async ({ page }) => {
	const f = await setup(page, true);
	for (const name of ["Original", "Replacement"]) {
		await page.getByRole("button", { name: "Add provider", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Model provider", exact: true });
		await dialog.getByLabel("Name", { exact: true }).fill(name);
		await dialog.getByRole("button", { name: "Continue", exact: true }).click();
		await expect(dialog.getByText("Account verified.")).toBeVisible();
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		expect(f.loginRequests()).toBe(0);
		if (name === "Original") {
			await page.getByRole("button", { name: "Remove Original", exact: true }).click();
			await page
				.getByRole("dialog", { name: "Remove provider", exact: true })
				.getByRole("button", { name: "Remove provider", exact: true })
				.click();
		}
	}
	expect(f.providers[0]!.retired).toBe(true);
	expect(f.providers[1]!.id).not.toBe(f.providers[0]!.id);
});

test("Config retains billing, instructions and Git identity", async ({ page }) => {
	const f = await setup(page);
	await expect(page.getByText("No model providers. Add one to configure agents.")).toBeVisible();
	await page.getByLabel("Planning instructions").fill("Check migrations.");
	await page.getByLabel("Implementation instructions").fill("Run tests.");
	await page.getByLabel("Git name").fill("Forge Developer");
	await page.getByLabel("Git email").fill("forge@example.com");
	await chooseDropdown(page.getByRole("combobox", { name: "Local currency" }), "EUR");
	await page.getByLabel("Monthly plan price").fill("45.5");
	await page.getByRole("button", { name: "Save settings" }).click();
	await expect(page.getByRole("status")).toHaveText("Settings saved.");
	expect(f.settings()).toMatchObject({ localCurrency: "EUR", monthlyPlanLocal: 45.5, gitName: "Forge Developer" });
	expect(f.settings()).not.toHaveProperty("inferenceProvider");
	await page.reload();
	await expect(page.getByLabel("Git email")).toHaveValue("forge@example.com");
});

for (const width of [1280, 390]) {
	test(`provider flows, comparison pricing, retirement and modal navigation at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		const f = await setup(page);
		await page.getByRole("button", { name: "Add provider", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Model provider", exact: true });
		await dialog.getByLabel("Name", { exact: true }).fill("Account");
		await dialog.getByRole("button", { name: "Continue", exact: true }).click();
		await expect.poll(() => f.providers.length).toBe(1);
		expect(f.writes[0]).toEqual({ name: "Account", kind: "openai", maxConcurrentAgents: 1 });
		await expect(dialog.getByText("ABCD-1234")).toBeVisible();
		await expect(dialog.getByRole("link")).toHaveAttribute("href", "https://auth.openai.com/codex/device");
		await dialog.getByRole("button", { name: "Cancel sign-in", exact: true }).click();
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Add provider", exact: true }).click();
		const type = dialog.getByRole("combobox", { name: "Provider type" });
		await type.click();
		const triggerBox = (await type.boundingBox())!;
		const listBox = (await dialog.getByRole("listbox", { name: "Provider type" }).boundingBox())!;
		expect(
			Math.min(
				Math.abs(listBox.y - (triggerBox.y + triggerBox.height)),
				Math.abs(triggerBox.y - (listBox.y + listBox.height)),
			),
		).toBeLessThanOrEqual(5);
		await expect(page.getByRole("option", { name: "OpenAI account", exact: true })).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		await type.press("Escape");
		await expect(dialog).toBeVisible();
		await dialog.getByLabel("Name", { exact: true }).fill("Local");
		await dialog.getByLabel("Responses API base URL").fill("http://ollama/v1");
		await dialog.getByLabel("Comparison model (optional)").fill("gpt-5.4");
		await dialog.getByLabel("Automatic compaction threshold (tokens)").fill("64000");
		await dialog.getByRole("button", { name: "Save provider", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		expect(f.providers[1]).toMatchObject({
			name: "Local",
			endpoint: "http://ollama/v1",
			comparisonModel: "gpt-5.4",
			compactionThresholdTokens: 64000,
		});
		expect(f.writes[1]).toMatchObject({ compactionThresholdTokens: 64000 });
		await page.getByRole("button", { name: "Edit Local", exact: true }).click();
		await expect(dialog.getByLabel("Automatic compaction threshold (tokens)")).toHaveValue("64000");
		await dialog.getByLabel("Automatic compaction threshold (tokens)").fill("");
		await dialog.getByLabel("Name", { exact: true }).fill("Renamed");
		await expect(dialog.getByLabel("Max concurrent agents")).toHaveValue("1");
		await dialog.getByLabel("Max concurrent agents").fill("3");
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await page.getByRole("button", { name: "Keep editing", exact: true }).click();
		await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Renamed");
		await dialog.getByRole("button", { name: "Save provider", exact: true }).click();
		await expect.poll(() => f.providers.at(1)?.maxConcurrentAgents).toBe(3);
		expect(f.writes.at(-1)).toMatchObject({ compactionThresholdTokens: null });
		await page.getByRole("button", { name: "Remove Renamed", exact: true }).click();
		await page
			.getByRole("dialog", { name: "Remove provider", exact: true })
			.getByRole("button", { name: "Remove provider", exact: true })
			.click();
		await expect(page.getByRole("heading", { name: "Renamed", exact: true })).toHaveCount(0);
		await page.goto(`/config?provider=${f.providers[0]!.id}`);
		await expect(dialog.getByLabel("Name", { exact: true })).toHaveValue("Account");
		await dialog.getByRole("button", { name: "Save provider", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await page.getByRole("button", { name: "Add provider", exact: true }).click();
		await page.goBack();
		await expect(dialog).toHaveCount(0);
		await page.goForward();
		await expect(dialog).toBeVisible();
		await dialog.press("Escape");
		await expect(dialog).toHaveCount(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	});
}
