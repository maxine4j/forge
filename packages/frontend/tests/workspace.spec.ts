import { expect, test } from "@playwright/test";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const head = "a".repeat(40);
test("existing file edits remain local, navigation guards drafts, and typing during Commit remains dirty", async ({
	page,
}) => {
	const mutations: unknown[] = [];
	let release: (() => void) | undefined;
	let committing = false;
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (request.method() !== "GET") {
				mutations.push(request.postDataJSON());
				committing = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return route.fulfill({ json: { head: "b".repeat(40) } });
			}
			if (url.pathname === "/api/projects")
				return route.fulfill({
					json: [{ id: projectId, name: "Project", status: "ready", createdAt: "2026-11-02T00:00:00.000Z" }],
				});
			if (url.pathname.endsWith("/branches")) return route.fulfill({ json: [{ name: "main", sha: head }] });
			if (url.pathname.endsWith("/tree")) {
				if (url.searchParams.get("path"))
					return route.fulfill({ status: 404, json: { error: "file-not-found" } });
				return route.fulfill({
					json: {
						path: "",
						head,
						entries: [{ name: "index.ts", path: "index.ts", kind: "file" }],
						truncated: false,
					},
				});
			}
			if (url.pathname.endsWith("/file"))
				return route.fulfill({ json: { path: "index.ts", content: "original" } });
			return route.fulfill({ status: 404, json: {} });
		},
	);
	await page.goto("/");
	await page.getByRole("link", { name: "Open Project" }).click();
	await page
		.getByRole("table", { name: "Repository files" })
		.getByRole("button", { name: "index.ts", exact: true })
		.click();
	const editor = page.getByRole("textbox", { name: "File editor" });
	await expect(editor).toBeVisible();
	await editor.fill("first snapshot");
	const fileUrl = page.url();
	await page.goBack();
	await expect(page).toHaveURL(`/projects/${projectId}/code`);
	await page.goBack();
	await expect(page.getByRole("alert")).toContainText("Uncommitted drafts remain");
	await expect(page).toHaveURL(`/projects/${projectId}/code`);
	await page.goForward();
	await expect(page).toHaveURL(fileUrl);
	await expect(editor).toContainText("first snapshot");
	await page.getByRole("button", { name: "Back to files", exact: true }).click();
	await page.getByRole("tab", { name: "index.ts *", exact: true }).click();
	await expect(editor).toContainText("first snapshot");
	expect(mutations).toEqual([]);
	await page.getByRole("link", { name: "Forge home", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("Uncommitted drafts remain");
	await page.getByRole("link", { name: "Config", exact: true }).click();
	await page.getByRole("link", { name: "Projects", exact: true }).click();
	await expect(page).toHaveURL("/config");
	await expect(page.getByRole("alert").filter({ hasText: "Uncommitted drafts remain" })).toBeVisible();
	await page.goBack();
	await expect(editor).toContainText("first snapshot");
	await page.getByLabel("Commit message").fill("Edit existing file");
	await page.getByRole("button", { name: "Commit", exact: true }).click();
	await expect.poll(() => committing).toBe(true);
	try {
		await editor.fill("newer draft");
	} finally {
		release?.();
	}
	await expect(page.getByRole("status").filter({ hasText: "Committed 1 file to main." })).toBeVisible();
	await expect(editor).toContainText("newer draft");
	await expect(page.getByRole("tab", { name: "index.ts *", exact: true })).toBeVisible();
	expect(mutations).toEqual([
		{
			branch: "main",
			expectedHead: head,
			message: "Edit existing file",
			files: [{ path: "index.ts", content: "first snapshot" }],
		},
	]);
	await page.getByRole("button", { name: "Discard all drafts" }).click();
	await expect(editor).toHaveCount(0);
	await page.getByRole("link", { name: "Forge home", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Your projects" })).toBeVisible();
});

test("an empty repository has no fabricated branch or checkout creation", async ({ page }) => {
	const mutations: string[] = [];
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		(route) => {
			if (route.request().method() !== "GET") mutations.push(route.request().url());
			if (new URL(route.request().url()).pathname === "/api/projects")
				return route.fulfill({
					json: [{ id: projectId, name: "Empty", status: "ready", createdAt: "2026-11-02T00:00:00.000Z" }],
				});
			return route.fulfill({ json: [] });
		},
	);
	await page.goto("/");
	await page.getByRole("link", { name: "Open Empty" }).click();
	await expect(page.getByText("No branches yet.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0);
	expect(mutations).toEqual([]);
});
