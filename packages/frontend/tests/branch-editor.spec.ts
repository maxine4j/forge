import { expect, test } from "@playwright/test";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const head = "a".repeat(40);
test("cards open projects; branch drafts stay local until one atomic commit and survive failed commits", async ({
	page,
}) => {
	page.on("pageerror", (error) => console.error(error.message));
	const mutations: { path: string; body: unknown }[] = [];
	let conflict = true;
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			if (request.method() !== "GET") {
				mutations.push({ path: url.pathname, body: request.postDataJSON() });
				return route.fulfill({
					status: conflict ? 409 : 200,
					json: conflict ? { error: "workspace-conflict" } : { head: "b".repeat(40) },
				});
			}
			if (url.pathname === "/api/projects")
				return route.fulfill({
					json: [{ id: projectId, name: "Forge", status: "ready", createdAt: "2026-11-02T00:00:00.000Z" }],
				});
			if (url.pathname.endsWith("/branches"))
				return route.fulfill({
					json: [
						{ name: "main", sha: head },
						{ name: "feature", sha: head },
					],
				});
			if (url.pathname.endsWith("/tree"))
				return route.fulfill({
					json: {
						path: "",
						head,
						entries: ["README.md", "index.ts"].map((name) => ({ name, path: name, kind: "file" })),
						truncated: false,
					},
				});
			if (url.pathname.endsWith("/file"))
				return route.fulfill({ json: { path: url.searchParams.get("path"), content: "original" } });
			return route.fulfill({ status: 404, json: {} });
		},
	);
	await page.goto("/");
	const card = page.getByRole("link", { name: "Open Forge", exact: true });
	await expect(card).toContainText("Created");
	await card.press("Enter");
	await expect(page.getByRole("combobox", { name: "Branch" })).toHaveValue("main");
	await expect(page.getByRole("option", { name: "Working changes" })).toHaveCount(0);
	await expect(page.getByText("Changes", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Pull requests", { exact: true })).toHaveCount(0);
	await expect(
		page.getByRole("navigation", { name: "File path" }).getByRole("button", { name: "Forge", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: "index.ts", exact: true }).click();
	const editor = page.getByRole("textbox", { name: "File editor" });
	await editor.fill("first draft");
	await page
		.getByRole("complementary", { name: "File tree" })
		.getByRole("button", { name: "Open README.md" })
		.click();
	await expect(page.getByRole("tab", { name: "README.md", exact: true })).toHaveAttribute("aria-selected", "true");
	await editor.fill("second draft");
	await page.getByRole("tab", { name: "index.ts *", exact: true }).click();
	await expect(editor).toContainText("first draft");
	await page.getByRole("combobox", { name: "Branch" }).selectOption("feature");
	await page.getByRole("button", { name: "index.ts", exact: true }).click();
	await expect(editor).toContainText("original");
	await page.getByRole("combobox", { name: "Branch" }).selectOption("main");
	await page.getByRole("tab", { name: "index.ts *", exact: true }).click();
	await expect(editor).toContainText("first draft");
	expect(mutations).toEqual([]);
	await expect(page.getByRole("button", { name: "Save file" })).toHaveCount(0);
	await page.getByLabel("Commit message").fill("Update both files");
	await page.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("branch");
	await expect(editor).toContainText("first draft");
	expect(mutations).toEqual([
		{
			path: `/api/projects/${projectId}/repository/commit`,
			body: {
				branch: "main",
				expectedHead: head,
				message: "Update both files",
				files: [
					{ path: "index.ts", content: "first draft" },
					{ path: "README.md", content: "second draft" },
				],
			},
		},
	]);
	conflict = false;
	await page.getByRole("button", { name: "Commit", exact: true }).click();
	await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0);
	await expect(page.getByRole("tab", { name: "index.ts", exact: true })).toBeVisible();
});
