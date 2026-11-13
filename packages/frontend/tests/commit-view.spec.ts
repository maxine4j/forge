import { expect, test } from "@playwright/test";

import { MockApi } from "../dev/mock-api.ts";
import { chooseDropdown, expectDropdownValue } from "./dropdown-helpers.ts";

const id = "123e4567-e89b-42d3-a456-426614174000";
const sha = "a".repeat(40),
	parent = "b".repeat(40);
const code = `/repos/${id}/code`;
const commitUrl = `${code}?branch=main&view=commit&sha=${sha}`;
test.beforeEach(async ({ page }) => {
	page.on("pageerror", (error) => {
		throw error;
	});
	const api = new MockApi();
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		(route) => {
			const json = api.read(new URL(route.request().url()));
			return route.fulfill({ status: json === undefined ? 404 : 200, json: json ?? { error: "not-found" } });
		},
	);
});

for (const mobile of [false, true])
	test(`commit layout and controls on ${mobile ? "mobile" : "desktop"}`, async ({ page }, testInfo) => {
		if (mobile) await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(commitUrl);
		await expect(page.getByRole("heading", { name: "Improve repository navigation" })).toBeVisible();
		await expect(page.locator(".commit-patch .addition").first()).toBeVisible();
		await expect(page.getByText("Binary or non-UTF-8 content — no text preview.")).toBeVisible();
		await page.locator(".commit-file").last().scrollIntoViewIfNeeded();
		await expect(page.getByText("Mode: 100644 → 100755")).toBeVisible();
		await page.getByRole("textbox", { name: "Filter changed files" }).fill("theme");
		await expect(page.getByRole("navigation", { name: "Changed files" }).getByRole("link")).toHaveCount(1);
		await page.getByRole("textbox", { name: "Filter changed files" }).fill("");
		const panel = page.locator(".commit-file").first();
		await panel.locator("summary").click();
		await expect(panel).not.toHaveAttribute("open", "");
		await page.getByRole("navigation", { name: "Changed files" }).getByRole("link").first().click();
		await expect(panel).toHaveAttribute("open", "");
		await chooseDropdown(page.getByRole("combobox", { name: "Diff view" }), "split");
		await expect(page).toHaveURL(/diff=split/u);
		const rows = panel.locator(".commit-patch tbody tr");
		await expect(rows.nth(1).locator("td").nth(1)).toHaveText("export const greeting = 'Hello';");
		await expect(rows.nth(1).locator("td").nth(3)).toHaveText("export const greeting = 'Hello, Forge';");
		await expect(rows.nth(2).locator("td.blank")).toHaveCount(1);
		await page.getByRole("checkbox", { name: "Hide whitespace" }).click();
		await expect(page.getByRole("checkbox", { name: "Hide whitespace" })).toBeChecked();
		await expect(page).toHaveURL(/ignoreWhitespace=true/u);
		await expect(page.locator(".commit-file").nth(1)).toContainText("No textual changes");
		await page.reload();
		await expectDropdownValue(page.getByRole("combobox", { name: "Diff view" }), "split");
		await expect(page.getByRole("checkbox", { name: "Hide whitespace" })).toBeChecked();
		await expect(page.locator(".commit-patch").first()).toBeVisible();
		await page.locator(".commit-file").last().scrollIntoViewIfNeeded();
		await expect(page.getByText("Mode: 100644 → 100755")).toBeVisible();
		await page.evaluate(() => window.scrollTo(0, 0));
		await page.screenshot({
			path: testInfo.outputPath(`commit-${mobile ? "mobile" : "desktop"}.png`),
			fullPage: true,
		});
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	});

test("history links retain context and drafts across parent and browser navigation", async ({ page }) => {
	await page.goto(`${code}?branch=main&path=src&file=src%2Findex.ts`);
	const editor = page.getByRole("textbox", { name: "File editor" });
	await expect(editor).toBeVisible();
	await editor.fill("const retainedDraft = true;");
	await page.getByRole("button", { name: "Commit history", exact: true }).click();
	const subject = page.getByRole("link", { name: "Improve repository navigation", exact: true });
	await expect(subject).toHaveAttribute("href", new RegExp(`path=src&file=src%2Findex.ts&view=commit&sha=${sha}`));
	await expect(page.getByRole("link", { name: "aaaaaaa", exact: true })).toHaveAttribute(
		"href",
		(await subject.getAttribute("href")) ?? "",
	);
	await subject.click();
	await page.locator(".commit-heading").getByRole("link", { name: "bbbbbbb", exact: true }).first().click();
	await expect(page).toHaveURL(new RegExp(`sha=${parent}`));
	await expect(page.getByRole("heading", { name: "Initialize project" })).toBeVisible();
	await page.goBack();
	await expect(page.getByRole("heading", { name: "Improve repository navigation" })).toBeVisible();
	await page.goForward();
	await expect(page.getByRole("heading", { name: "Initialize project" })).toBeVisible();
	await page.getByRole("link", { name: "Back to history" }).click();
	await page.getByRole("button", { name: "Back to files", exact: true }).click();
	await page
		.getByRole("table", { name: "Repository files" })
		.getByRole("button", { name: "index.ts", exact: true })
		.click();
	await expect(editor).toHaveText("const retainedDraft = true;");
});

test("changed files group into collapsible folders with GitHub status icons and pills", async ({ page }) => {
	const api = new MockApi();
	await page.route(`**/commits/${sha}`, (route) => {
		const detail = api.read(new URL(route.request().url())) as { files: unknown[] };
		return route.fulfill({
			json: {
				...detail,
				files: [
					...detail.files,
					{ path: "src/legacy/old.ts", status: "D", additions: 0, deletions: 1, binary: false },
				],
			},
		});
	});
	await page.goto(commitUrl);
	const tree = page.getByRole("navigation", { name: "Changed files" });
	const src = tree.getByRole("button", { name: "src", exact: true });
	const modified = tree.getByRole("link", { name: /index\.ts/ });
	const removed = tree.getByRole("link", { name: /old\.ts/ });
	await expect(src).toHaveAttribute("aria-expanded", "true");
	await expect(tree.getByRole("button", { name: "legacy", exact: true })).toBeVisible();
	for (const [file, letter, label, icon] of [
		[modified, "M", "Modified", "file-diff"],
		[tree.getByRole("link", { name: /logo\.bin/ }), "A", "Added", "file-added"],
		[removed, "D", "Deleted", "file-removed"],
		[tree.getByRole("link", { name: /theme\.css/ }), "R", "Renamed", "file-moved"],
	] as const) {
		await expect(file.getByTitle(label)).toHaveText(letter);
		await expect(file).toHaveAccessibleName(new RegExp(label));
		await expect(file.locator(`svg.octicon-${icon}`)).toBeVisible();
	}
	await src.click();
	await expect(modified).toBeHidden();
	await expect(removed).toBeHidden();
	await page.getByRole("textbox", { name: "Filter changed files" }).fill("old.ts");
	await expect(removed).toBeVisible();
	await expect(tree.getByRole("link")).toHaveCount(1);
});

test("metadata and patch loading failures have working retries", async ({ page }) => {
	let fail = true;
	await page.route(`**/commits/${sha}`, async (route) =>
		fail ? route.fulfill({ status: 503, json: { error: "workspace-unavailable" } }) : route.fallback(),
	);
	await page.goto(commitUrl);
	await expect(page.getByRole("alert")).toContainText("Commit unavailable");
	fail = false;
	let failPatch = true;
	await page.route("**/diff?**", (route) =>
		failPatch ? route.fulfill({ status: 503, json: { error: "workspace-unavailable" } }) : route.fallback(),
	);
	await page.getByRole("button", { name: "Retry commit" }).click();
	await expect(page.getByText("Diff unavailable.", { exact: false }).first()).toBeVisible();
	failPatch = false;
	await page.getByRole("button", { name: "Retry diffs" }).first().click();
	await expect(page.locator(".commit-patch").first()).toBeVisible();
});

test("stale whitespace requests are ignored and share a four-request bound", async ({ page }) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	let requests = 0,
		active = 0,
		max = 0;
	const api = new MockApi();
	await page.route("**/diff?**", async (route) => {
		requests++;
		active++;
		max = Math.max(max, active);
		const url = new URL(route.request().url());
		if (url.searchParams.get("ignoreWhitespace") === "false") await pending;
		const json = api.read(url);
		active--;
		await route.fulfill({ json });
	});
	await page.goto(commitUrl);
	await expect.poll(() => requests).toBe(4);
	await page.getByRole("checkbox", { name: "Hide whitespace" }).click();
	await expect(page.getByRole("checkbox", { name: "Hide whitespace" })).toBeChecked();
	release();
	await expect(page.locator(".commit-file").nth(1)).toContainText("No textual changes");
	expect(max).toBeLessThanOrEqual(4);
});
