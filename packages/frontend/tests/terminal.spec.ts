import { expect, test } from "@playwright/test";

test("terminal automatically creates, fits, reconnects, replaces lost shells and detaches on navigation", async ({
	page,
}) => {
	const projectId = "123e4567-e89b-42d3-a456-426614174000";
	const id = "123e4567-e89b-42d3-a456-426614174001";
	let terminalId = "123e4567-e89b-42d3-a456-426614174002";
	const head = "a".repeat(40);
	const createdAt = "2026-11-02T00:00:00.000Z";
	const workspace = {
		id,
		projectId,
		name: "Manual",
		branch: `forge/workspace/${id}`,
		head,
		baseSha: head,
		status: "ready",
		createdAt,
	};
	let session: object | undefined;
	let status = "running";
	const current = () => ({ id: terminalId, workspaceId: id, status, cols: 80, rows: 24, createdAt });
	let creates = 0;
	let attaches = 0;
	let reads = 0;
	let disconnected = 0;
	let endShell = () => {};
	const inputs: unknown[] = [];
	await page.route("**/api/accounts", (route) => route.fulfill({ status: 503, json: {} }));
	await page.route("**/api/projects", (route) =>
		route.fulfill({ json: [{ id: projectId, name: "Project", status: "ready", createdAt }] }),
	);
	await page.route(`**/api/projects/${projectId}/workspaces`, (route) => route.fulfill({ json: [workspace] }));
	await page.route(`**/api/projects/${projectId}/pull-requests`, (route) => route.fulfill({ json: [] }));
	await page.route(`**/api/workspaces/${id}/tree?*`, (route) =>
		route.fulfill({ json: { path: "", entries: [], truncated: false } }),
	);
	const empty = { files: [], patch: "", truncated: false };
	await page.route(`**/api/workspaces/${id}/diff`, (route) =>
		route.fulfill({
			json: {
				comparison: "merge-base(main, workspace)..workspace",
				baseSha: head,
				head,
				branch: empty,
				staged: empty,
				unstaged: empty,
				untracked: empty,
			},
		}),
	);
	await page.route(`**/api/workspaces/${id}/terminal`, (route) => {
		if (route.request().method() === "POST") {
			creates++;
			terminalId = `123e4567-e89b-42d3-a456-${String(creates + 1).padStart(12, "0")}`;
			status = "running";
			session = current();
			// Creation succeeded but its response was lost: inspect and attach, never repeat the POST.
			if (creates === 1) return route.fulfill({ status: 503, json: { error: "terminal-unavailable" } });
			return route.fulfill({ status: 201, json: session });
		}
		// A failed inspection must retry without creating a duplicate shell.
		if (++reads === 1) return route.fulfill({ status: 503, json: { error: "terminal-unavailable" } });
		return route.fulfill({ json: session ? { session } : {} });
	});
	await page.routeWebSocket("**/api/terminals/*/socket?after=*", (socket) => {
		attaches++;
		if (attaches === 1) expect(socket.url()).toContain("after=0");
		else expect(socket.url()).toContain(attaches === 2 ? "after=1" : "after=0");
		endShell = () => {
			status = "exited";
			session = current();
			socket.send(JSON.stringify({ type: "status", session }));
		};
		socket.onClose(() => {
			disconnected++;
			void socket.close();
		});
		socket.onMessage((message) => inputs.push(JSON.parse(String(message))));
		socket.send(JSON.stringify({ type: "output", sequence: 1, data: "real terminal bytes\r\n" }));
		socket.send(JSON.stringify({ type: "status", session: current() }));
		if (attaches === 1) setTimeout(() => socket.close(), 250);
		else if (attaches === 2) {
			socket.send(JSON.stringify({ type: "gap", through: 10 }));
			// Ignore a status frame for another workspace.
			socket.send(
				JSON.stringify({ type: "status", session: { ...current(), workspaceId: projectId, status: "closed" } }),
			);
		}
	});
	await page.goto("/");
	await page.getByRole("link", { name: "Open Project" }).click();
	await page.getByRole("tab", { name: "Terminals", exact: true }).click();
	await expect.poll(() => creates).toBe(1);
	await expect(page.getByRole("region", { name: "Terminal", exact: true }).getByRole("button")).toHaveCount(0);
	await expect(page.locator(".xterm")).toBeVisible();
	await expect
		.poll(() =>
			inputs.some(
				(input) => typeof input === "object" && input !== null && "type" in input && input.type === "resize",
			),
		)
		.toBe(true);
	await expect.poll(() => attaches).toBe(2);
	await expect(page.getByText("Output gap through 10. Some terminal output is unavailable.")).toBeVisible();
	await page.locator(".xterm-helper-textarea").fill("echo hello\n");
	await expect
		.poll(() =>
			inputs.some(
				(input) => typeof input === "object" && input !== null && "type" in input && input.type === "input",
			),
		)
		.toBe(true);
	expect(creates).toBe(1);
	endShell();
	await expect.poll(() => creates).toBe(2);
	await expect.poll(() => attaches).toBe(3);
	await expect(page.getByText("Output gap through 10. Some terminal output is unavailable.")).toHaveCount(0);
	const beforeLeaving = disconnected;
	await page.getByRole("link", { name: "Forge home", exact: true }).click();
	await expect.poll(() => disconnected).toBeGreaterThan(beforeLeaving);
	const detached = attaches;
	await page.waitForTimeout(1500);
	expect(attaches).toBe(detached);
	status = "lost";
	session = current();
	await page.getByRole("link", { name: "Open Project" }).click();
	await page.getByRole("tab", { name: "Terminals", exact: true }).click();
	await expect.poll(() => creates).toBe(3);
	await expect.poll(() => attaches).toBe(4);
	await expect(page.getByText("Connected", { exact: true })).toBeVisible();
	await page.screenshot({ path: "../../artifacts/forge/terminal-automatic.png", fullPage: true });
});
