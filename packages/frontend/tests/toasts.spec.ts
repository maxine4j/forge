import { expect, test } from "@playwright/test";

test.use({ hasTouch: true });

test.beforeEach(async ({ page }) => {
	await page.goto("/tests/toasts.html");
	await page.clock.install({ time: new Date("2026-11-13T12:00:00Z") });
	await page.clock.pauseAt(new Date("2026-11-13T12:00:01Z"));
});

test("FIFO, repeat counts, full visible time, sweep restart and keyboard dismissal", async ({ page }) => {
	const alert = page.getByRole("alert");
	await page.getByRole("button", { name: "First", exact: true }).click();
	await expect(alert).toHaveText("First failure");
	const firstSweep = await page.locator(".forge-toast-sweep").elementHandle();
	await page.clock.runFor(2200);
	await page.getByRole("button", { name: "Second", exact: true }).click();
	await page.getByRole("button", { name: "Third", exact: true }).click();
	await expect(page.getByText("Second failure", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Third failure", { exact: true })).toHaveCount(0);
	await page.getByRole("button", { name: "Second", exact: true }).click();
	expect(await firstSweep!.evaluate((node) => node.isConnected)).toBe(true);
	await page.getByRole("button", { name: "First", exact: true }).click();
	await expect(alert).toHaveText("2x First failure");
	expect(await firstSweep!.evaluate((node) => node.isConnected)).toBe(false);
	await expect(page.locator(".forge-toast-sweep")).toHaveCSS("animation-delay", "0s");
	await page.clock.runFor(2999);
	await expect(alert).toHaveText("2x First failure");
	await page.clock.runFor(1);
	await expect(alert).toHaveText("2x Second failure");
	await page.getByRole("button", { name: "Dismiss notification" }).focus();
	await page.keyboard.press("Enter");
	await expect(alert).toHaveText("Third failure");
	await page.clock.runFor(3000);
	await expect(alert).toHaveCount(0);
	await page.getByRole("button", { name: "First", exact: true }).click();
	await expect(alert).toHaveText("First failure");
});

test("nested native modals rehost one tappable viewport without extending the deadline", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 900 });
	await page.getByRole("button", { name: "Open outer" }).click();
	await page.getByRole("button", { name: "Outer failure" }).click();
	await page.clock.runFor(1000);
	await page.getByRole("button", { name: "Open inner" }).click();
	await expect(page.locator("dialog dialog .forge-toast-viewport:popover-open")).toBeVisible();
	await expect
		.poll(async () => {
			const box = (await page.locator(".forge-toast-viewport").boundingBox())!;
			return Math.round(box.y + box.height);
		})
		.toBe(884);
	await page.getByRole("button", { name: "Inner failure" }).click();
	const toast = page.getByRole("button", { name: "Dismiss notification" });
	await toast.tap();
	await expect(page.getByRole("alert")).toHaveText("Second failure");
	await expect(page.getByRole("button", { name: "Close inner" })).toBeVisible();
	await page.clock.runFor(1500);
	await page.getByRole("button", { name: "Close inner" }).click();
	await expect(page.locator("dialog:modal > div .forge-toast-viewport:popover-open")).toBeVisible();
	await page.clock.runFor(1500);
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Close outer" })).toBeVisible();
});

test("unchanged polled failures announce only once", async ({ page }) => {
	await page.getByRole("button", { name: "Poll failure", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveText("Saved failure");
	await page.getByRole("button", { name: "Poll unchanged 0" }).click();
	await expect(page.getByRole("alert")).toHaveText("Saved failure");
	await page.clock.runFor(3000);
	await page.getByRole("button", { name: "Poll unchanged 1" }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
});

for (const width of [390, 600, 768, 1280]) {
	test(`composer placement at ${width}px, growth, hidden chat and reduced motion`, async ({ page }) => {
		await page.setViewportSize({ width, height: 850 });
		await page.getByRole("button", { name: "First", exact: true }).click();
		const viewport = page.locator(".forge-toast-viewport");
		const composer = page.locator(".agent-composer");
		const assertPlacement = async () => {
			await expect
				.poll(async () => {
					const toast = (await viewport.boundingBox())!;
					const anchor = (await composer.boundingBox())!;
					return Math.round((width <= 600 ? anchor.y - 8 : 834) - (toast.y + toast.height));
				})
				.toBe(0);
		};
		await assertPlacement();
		await composer.locator("textarea").evaluate((node) => {
			node.style.height = "240px";
		});
		await assertPlacement();
		await page.getByRole("button", { name: "Toggle chat" }).click();
		await expect
			.poll(async () => {
				const box = (await viewport.boundingBox())!;
				return Math.round(box.y + box.height);
			})
			.toBe(834);
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expect(page.locator(".forge-toast")).toHaveCSS("animation-name", "none");
		await expect(page.locator(".forge-toast-sweep")).toHaveCSS("animation-name", "none");
		await page.clock.runFor(3000);
		await expect(page.getByRole("alert")).toHaveCount(0);
	});
}

test("request retries count once each and toasts survive application route changes", async ({ page }) => {
	await page.route("**/api/projects", (route) =>
		route.request().method() === "GET"
			? route.fulfill({ json: [] })
			: route.fulfill({ status: 503, json: { error: "project-unavailable" } }),
	);
	await page.route("**/api/accounts", (route) =>
		route.fulfill({
			json: {
				codex: { connection: "available", login: { state: "idle" } },
				github: { connection: "available", login: { state: "idle" } },
			},
		}),
	);
	await page.goto("/repos");
	await page.getByRole("button", { name: "Create repo", exact: true }).click();
	await page.getByRole("button", { name: "Create repository", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("Please fill out this field");
	await page.getByRole("button", { name: "Dismiss notification" }).click();
	await page.getByLabel("Repository name", { exact: true }).fill("Example");
	await page.getByRole("button", { name: "Create repository", exact: true }).click();
	await expect(page.getByRole("alert")).toBeVisible();
	const message = await page.getByRole("alert").textContent();
	await page.getByRole("button", { name: "Create repository", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveText(`2x ${message}`);
	await page.getByRole("button", { name: "Close repository form" }).click();
	await page.getByRole("link", { name: "Tasks", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveText(`2x ${message}`);
});
