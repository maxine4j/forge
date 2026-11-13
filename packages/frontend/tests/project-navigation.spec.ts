import { expect, test } from "@playwright/test";

test("dark project tabs hide infrastructure and keep account setup in Config", async ({ page }) => {
	const projectId = "123e4567-e89b-42d3-a456-426614174000";
	const id = "123e4567-e89b-42d3-a456-426614174001";
	const head = "a".repeat(40);
	const createdAt = "2026-11-02T00:00:00.000Z";
	const workspace = {
		id,
		projectId,
		name: "Project files",
		branch: `forge/workspace/${id}`,
		head,
		baseSha: head,
		status: "ready",
		createdAt,
	};
	let prepared = false;
	let preparations = 0;
	let shells = 0;
	const session = {
		id: "123e4567-e89b-42d3-a456-426614174002",
		workspaceId: id,
		status: "running",
		cols: 80,
		rows: 24,
		createdAt,
	};
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		(route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === "/api/projects")
				return route.fulfill({ json: [{ id: projectId, name: "Forge", status: "ready", createdAt }] });
			if (path === "/api/accounts")
				return route.fulfill({
					json: {
						codex: { connection: "available", login: { state: "idle" } },
						github: { connection: "available", login: { state: "idle" } },
					},
				});
			if (path.endsWith("/branches")) return route.fulfill({ json: [{ name: "main", sha: head }] });
			if (path.endsWith("/pipelines")) return route.fulfill({ json: { commit: head, workflows: [] } });
			if (path.endsWith("/pipeline-runs")) return route.fulfill({ json: { runs: [], hasMore: false } });
			if (path.endsWith("/workspaces")) {
				if (route.request().method() === "POST") {
					preparations++;
					prepared = true;
					return route.fulfill({ status: 201, json: workspace });
				}
				return route.fulfill({ json: prepared ? [workspace] : [] });
			}
			if (path.endsWith("/tree"))
				return route.fulfill({
					json: {
						path: "",
						head,
						entries: [{ path: "readme.md", name: "readme.md", kind: "file" }],
						truncated: false,
					},
				});
			if (path.endsWith("/diff")) {
				const empty = { files: [], patch: "", truncated: false };
				return route.fulfill({
					json: {
						comparison: "merge-base(main, workspace)..workspace",
						head,
						baseSha: head,
						branch: empty,
						staged: empty,
						unstaged: empty,
						untracked: empty,
					},
				});
			}
			if (path.endsWith("/terminal")) {
				if (route.request().method() === "POST") {
					shells++;
					return route.fulfill({ status: 201, json: session });
				}
				return route.fulfill({ json: shells ? { session } : {} });
			}
			if (path.endsWith("/pull-requests")) return route.fulfill({ json: [] });
			if (path.endsWith("/agents")) return route.fulfill({ json: [] });
			return route.fulfill({ status: 404, json: {} });
		},
	);
	await page.routeWebSocket("**/api/terminals/*/socket?after=*", (socket) => {
		socket.send(JSON.stringify({ type: "status", session }));
	});
	await page.goto("/repos");
	await expect(page.getByRole("link", { name: "Open Forge" })).toHaveAttribute("href", `/repos/${projectId}/code`);
	await expect(page.getByRole("button", { name: "Sign in", exact: true })).toHaveCount(0);
	await page.getByRole("link", { name: "Open Forge" }).click();
	await expect(page).toHaveURL(`/repos/${projectId}/code`);
	for (const size of [
		{ width: 1280, height: 900 },
		{ width: 448, height: 960 },
		{ width: 820, height: 820 },
	]) {
		await page.setViewportSize(size);
		const header = page.getByRole("banner");
		await expect(header.getByRole("link", { name: "Forge home" })).toBeVisible();
		await expect(header.getByRole("heading")).toHaveCount(0);
		await expect(
			page
				.getByRole("region", { name: "Repository", exact: true })
				.getByRole("heading", { name: "Forge", exact: true }),
		).toHaveCount(0);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	}
	await page.setViewportSize({ width: 1280, height: 900 });
	await expect(page.getByRole("button", { name: "readme.md", exact: true })).toBeVisible();
	expect(prepared).toBe(false);
	expect(preparations).toBe(0);
	await expect(page.getByText(/workspace/i)).toHaveCount(0);
	await expect(page.getByText(head, { exact: false })).toHaveCount(0);
	await page.getByRole("tab", { name: "Agents", exact: true }).click();
	await expect(page.getByRole("tab", { name: "Agents", exact: true })).toHaveAttribute(
		"href",
		`/repos/${projectId}/agents`,
	);
	await expect(page).toHaveURL(`/repos/${projectId}/agents`);
	await page.reload();
	await expect(page.getByRole("tab", { name: "Agents", exact: true })).toHaveAttribute("aria-selected", "true");
	await expect(page.getByRole("button", { name: "Create chat", exact: true })).toBeVisible();
	expect(preparations).toBe(0);
	for (const name of ["Pipelines"]) {
		await page.getByRole("tab", { name, exact: true }).click();
		await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
		await expect(page.getByRole("tabpanel", { name, exact: true })).toContainText("No workflows found");
	}
	await page.getByRole("tab", { name: "Terminals", exact: true }).click();
	await expect(page.getByRole("region", { name: "Terminal", exact: true })).toContainText("Connected");
	await expect(page.getByRole("button", { name: "Create shell", exact: true })).toHaveCount(0);
	expect(shells).toBe(1);
	await page.reload();
	await expect(page.getByRole("region", { name: "Terminal", exact: true })).toContainText("Connected");
	expect(shells).toBe(1);
	await page.getByRole("link", { name: "Config", exact: true }).click();
	await expect(page).toHaveURL(/\/config$/);
	await expect(page.getByRole("region", { name: "ChatGPT" })).toBeVisible();
	await expect(page.getByRole("tablist", { name: "Repository sections" })).toBeHidden();
	await page.goBack();
	await expect(page).toHaveURL(`/repos/${projectId}/terminals`);
	await expect(page.getByRole("region", { name: "Terminal", exact: true })).toContainText("Connected");
	expect(shells).toBe(1);
	await page.goForward();
	await expect(page.getByRole("region", { name: "ChatGPT" })).toBeVisible();
	await page.goBack();
	await page.getByRole("tab", { name: "Code", exact: true }).click();
	await expect(page.getByRole("button", { name: "readme.md", exact: true })).toBeVisible();
	await page.getByRole("link", { name: "Repos", exact: true }).click();
	await page.getByRole("link", { name: "Open Forge" }).click();
	await expect(page.getByRole("button", { name: "readme.md", exact: true })).toBeVisible();
	expect(preparations).toBe(1);
	await page.setViewportSize({ width: 390, height: 844 });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
	for (const size of [
		{ width: 1280, height: 900 },
		{ width: 448, height: 960 },
		{ width: 820, height: 820 },
	]) {
		await page.setViewportSize(size);
		await page.getByRole("tab", { name: "Agents", exact: true }).click();
		await expect(page.getByRole("tab", { name: "Agents", exact: true })).toHaveAttribute("aria-selected", "true");
		const spacing = () =>
			page.getByRole("tablist", { name: "Repository sections" }).evaluate((tabs) => {
				const bounds = tabs.getBoundingClientRect();
				return {
					top: bounds.top - document.querySelector("header")!.getBoundingClientRect().bottom,
					left: bounds.left,
					height: bounds.height,
					bottom: getComputedStyle(tabs).marginBottom,
				};
			});
		const expected = await spacing();
		for (const name of ["Code", "Pipelines", "Terminals"]) {
			await page.getByRole("tab", { name, exact: true }).click();
			await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
			await expect.poll(spacing, `${name} spacing at ${size.width}px`).toEqual(expected);
		}
	}
	await page.goto("/missing");
	await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
	await page.goto(`/repos/missing/code`);
	await expect(page.getByRole("heading", { name: "Repository unavailable" })).toBeVisible();
});
