import { expect, test } from "@playwright/test";
const id = "123e4567-e89b-42d3-a456-426614174000";
const project = { id, name: "Documentation", status: "ready", createdAt: "2026-11-02T00:00:00.000Z" };
const idle = { connection: "available", login: { state: "idle" } };

test("create/import and retry projects while account infrastructure is unavailable", async ({ page }) => {
	let projects: unknown[] = [];
	let created: unknown;
	await page.route("**/api/accounts", (route) => route.fulfill({ status: 503, json: { error: "internal-error" } }));
	await page.route("**/api/projects", async (route) => {
		if (route.request().method() === "POST") {
			created = route.request().postDataJSON();
			projects = [project];
			await route.fulfill({ status: 201, json: project });
		} else await route.fulfill({ json: projects });
	});
	await page.goto("/repos");
	await expect(page.getByText("No repos yet")).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	const open = page.getByRole("button", { name: "Create repo", exact: true });
	const dialog = page.getByRole("dialog", { name: "New repository" });
	await expect(dialog).toBeHidden();
	await expect(page.getByRole("button", { name: "Refresh repos" })).toHaveCount(0);
	await open.click();
	await expect(dialog.getByLabel("Repository name")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(open).toBeFocused();
	await open.click();
	await dialog.getByLabel("Repository name").fill("Documentation");
	await dialog.getByLabel("Import repository (optional)").fill("https://github.com/example/docs.git");
	await dialog.getByRole("button", { name: "Create repository", exact: true }).click();
	await expect(dialog).toBeHidden();
	await expect(open).toBeFocused();
	await expect(page.getByRole("heading", { name: "Documentation" })).toBeVisible();
	expect(created).toEqual({ name: "Documentation", source: "https://github.com/example/docs.git" });
	projects = [{ ...project, status: "failed" }];
	await page.route(`**/api/projects/${id}/retry`, (route) => route.fulfill({ json: project }));
	await page.getByRole("button", { name: "Retry Documentation" }).click();
	await expect(page.getByText("Ready", { exact: true })).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await expect(page.getByRole("heading", { name: "Documentation" })).toBeVisible();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("account verification code/link, completion, cancellation, uncertainty and explicit retry", async ({ page }) => {
	let codex: unknown = idle;
	await page.route("**/api/projects", (route) =>
		route.fulfill({
			json: [project, { ...project, id: "123e4567-e89b-42d3-a456-426614174001", name: "Homelab dashboard" }],
		}),
	);
	await page.route("**/api/accounts", (route) => route.fulfill({ json: { codex, github: idle } }));
	await page.route("**/api/accounts/codex/*", (route) => {
		const action = route.request().url().split("/").at(-1);
		codex =
			action === "cancel"
				? { connection: "available", login: { state: "cancelled" } }
				: {
						connection: "available",
						login: {
							state: "pending",
							userCode: "ABCD-EFGH",
							verificationUrl: "https://auth.openai.com/codex/device",
						},
					};
		return route.fulfill({ json: codex });
	});
	await page.goto("/repos");
	await page.getByRole("link", { name: "Config", exact: true }).click();
	const card = page.getByRole("region", { name: "ChatGPT" });
	await card.getByRole("button", { name: "Sign in" }).click();
	await expect(card.getByText("ABCD-EFGH")).toBeVisible();
	await page.screenshot({ path: "../../artifacts/forge/desktop.png", fullPage: true });
	await page.setViewportSize({ width: 390, height: 844 });
	await page.screenshot({ path: "../../artifacts/forge/mobile.png", fullPage: true });
	await page.setViewportSize({ width: 1280, height: 900 });
	await expect(card.getByRole("link", { name: "Open verification page" })).toHaveAttribute(
		"href",
		"https://auth.openai.com/codex/device",
	);
	await card.getByRole("button", { name: "Cancel sign-in" }).click();
	await expect(card.getByText("Sign-in cancelled.")).toBeVisible();
	codex = { connection: "available", login: { state: "uncertain", failure: "connection-lost" } };
	await page.getByRole("button", { name: "Refresh accounts" }).click();
	await expect(card.getByText(/Previous sign-in outcome is unknown/)).toBeVisible();
	await card.getByRole("button", { name: "Retry sign-in" }).click();
	await expect(card.getByText("ABCD-EFGH")).toBeVisible();
	codex = { connection: "available", account: { name: "owner@example.com" }, login: { state: "completed" } };
	await page.getByRole("button", { name: "Refresh accounts" }).click();
	await expect(card.getByText("owner@example.com")).toBeVisible();
	await expect(card.getByText("ABCD-EFGH")).toHaveCount(0);
});

test("a failed create refreshes durable failed intent for explicit retry", async ({ page }) => {
	let failed = false;
	await page.route("**/api/accounts", (route) => route.fulfill({ json: { codex: idle, github: idle } }));
	await page.route("**/api/projects", (route) => {
		if (route.request().method() === "POST") {
			failed = true;
			return route.fulfill({ status: 503, json: { error: "project-unavailable" } });
		}
		return route.fulfill({ json: failed ? [{ ...project, status: "failed" }] : [] });
	});
	await page.goto("/repos");
	await page.getByRole("button", { name: "Create repo", exact: true }).click();
	const dialog = page.getByRole("dialog", { name: "New repository" });
	await dialog.getByLabel("Repository name").fill("Documentation");
	await dialog.getByRole("button", { name: "Create repository", exact: true }).click();
	await expect(dialog.getByRole("alert")).toContainText("Repository operation failed");
	await expect(dialog.getByLabel("Repository name")).toHaveValue("Documentation");
	await dialog.getByRole("button", { name: "Close repository form" }).click();
	await expect(page.getByRole("button", { name: "Retry Documentation" })).toBeVisible({ timeout: 1000 });
});
