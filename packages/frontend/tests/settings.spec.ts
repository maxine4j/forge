import { expect, test } from "@playwright/test";

test("Config saves and reloads Forge-wide agent instructions and Git identity", async ({ page }) => {
	let settings = {
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
	await page.route("**/api/settings", (route) => {
		if (route.request().method() === "PUT") {
			settings = route.request().postDataJSON();
			updates.push(settings);
		}
		return route.fulfill({ json: settings });
	});
	await page.goto("/projects");
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
	await page.getByRole("button", { name: "Save settings" }).click();
	await expect(page.getByRole("status")).toHaveText("Settings saved.");
	expect(updates).toEqual([
		{
			planningInstructions: "Check migrations.\nInclude rollback steps.",
			implementationInstructions: "Run focused tests.",
			gitName: "Forge Developer",
			gitEmail: "forge@example.com",
		},
	]);
	await page.reload();
	await expect(page.getByLabel("Planning instructions")).toHaveValue(settings.planningInstructions);
	await expect(page.getByLabel("Implementation instructions")).toHaveValue(settings.implementationInstructions);
	await expect(page.getByLabel("Git name")).toHaveValue(settings.gitName);
	await expect(page.getByLabel("Git email")).toHaveValue(settings.gitEmail);
});
