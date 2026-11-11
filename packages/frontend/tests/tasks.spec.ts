import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const createdAt = "2026-11-03T00:00:00.000Z";
const setup = async (page: Page, crowded = false, agentic = false, review = false) => {
	const threadId = "123e4567-e89b-42d3-a456-426614174010";
	let messages = 0;
	let approved = false;
	let boardSettings = { dispatch: "running", maxAgents: 3 };
	let stopRequests = 0;
	const approvals: unknown[] = [];
	let tickets: {
		id: string;
		projectId: string;
		title: string;
		description: string;
		status: string;
		createdAt: string;
		needsAttention?: true;
	}[] = [
		{ id: "FORGE-1", projectId, title: "First task", description: "Scope", status: "backlog", createdAt },
		{ id: "FORGE-2", projectId, title: "Second task", description: "", status: "backlog", createdAt },
	];
	let failMove = false;
	let failArchive = false;
	let hold: Promise<void> | undefined;
	let release = () => {};
	let held = 0;
	const operations: string[] = [];
	if (agentic) tickets[0]!.status = "in-progress";
	if (agentic && !review) tickets[0]!.needsAttention = true;
	if (crowded)
		tickets = Array.from({ length: 60 }, (_, i) => ({
			id: `FORGE-${i + 1}`,
			projectId,
			title: `Task ${i + 1}`,
			description: "Scope",
			status: i < 30 ? "backlog" : "todo",
			createdAt,
		}));
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const path = new URL(route.request().url()).pathname;
			const method = route.request().method();
			if (path === "/api/board/settings") {
				if (method === "PATCH") boardSettings = { ...boardSettings, ...route.request().postDataJSON() };
				return route.fulfill({ json: boardSettings });
			}
			if (path === "/api/board/settings/stop") {
				stopRequests++;
				boardSettings = { ...boardSettings, dispatch: "stopped" };
				return route.fulfill({ json: { settings: boardSettings, requested: 2, failed: 1 } });
			}
			if (path.endsWith("/workflow") || path.endsWith("/messages") || path.endsWith("/approve")) {
				if (path.endsWith("/messages")) messages++;
				if (path.endsWith("/approve")) {
					approvals.push(route.request().postDataJSON());
					approved = true;
					delete tickets[0]!.needsAttention;
				}
				return route.fulfill({
					json: {
						ticketId: path.split("/")[3],
						phase: review || approved ? "implementation" : "planning",
						state: review ? "running" : approved ? "queued" : "idle",
						mergeAttempts: 0,
						...(review ? { implementerId: threadId } : {}),
						...(agentic
							? {
									plannerId: threadId,
									plan: {
										revision: 1,
										text: "## Search plan\n\n1. Add **filtering**.\n\n<script>unsafe</script>",
									},
								}
							: {}),
					},
				});
			}
			if (path.startsWith("/api/agents/")) {
				if (path.endsWith("/events"))
					return route.fulfill({ status: 200, contentType: "text/event-stream", body: "data: changed\n\n" });
				return route.fulfill({
					json: {
						thread: {
							id: threadId,
							projectId,
							workspaceId: threadId,
							title: "Planning",
							createdAt,
							status: review ? "waiting" : "completed",
							...(review ? { turnId: "turn" } : {}),
						},
						items: Array.from({ length: 30 }, (_, i) => ({
							id: `item-${i}`,
							role: i % 2 ? "user" : "assistant",
							text: `Planning message ${i}: implement search with tests.`,
						})),
						requests: review
							? [
									{ id: "approval", kind: "command", description: "Execute", questions: [] },
									{
										id: "input",
										kind: "input",
										description: "Clarify",
										questions: [
											{ id: "scope", question: "Which files?", secret: false, options: [] },
										],
									},
								]
							: [],
						truncated: false,
					},
				});
			}
			if (path === "/api/projects")
				return route.fulfill({ json: [{ id: projectId, name: "Forge", status: "ready", createdAt }] });
			if (path === "/api/accounts")
				return route.fulfill({
					json: {
						codex: { connection: "available", login: { state: "idle" } },
						github: { connection: "available", login: { state: "idle" } },
					},
				});
			if (path.endsWith("/tickets")) {
				if (method === "POST") {
					const ticket = {
						...route.request().postDataJSON(),
						id: `FORGE-${tickets.length + 1}`,
						projectId,
						status: "backlog",
						createdAt,
					};
					tickets.push(ticket);
					return route.fulfill({ status: 201, json: ticket });
				}
				if (hold) {
					held++;
					await hold;
					operations.push("read");
				}
				return route.fulfill({ json: tickets });
			}
			if (path.startsWith("/api/tickets/")) {
				const ticket = tickets.find((value) => value.id === path.split("/")[3])!;
				if (path.endsWith("/archive") && method === "POST") {
					operations.push("archive");
					if (failArchive) return route.fulfill({ status: 503, json: { error: "ticket-unavailable" } });
					tickets = tickets.filter((value) => value.id !== ticket.id);
					return route.fulfill({ json: { ...ticket, archivedAt: createdAt } });
				}
				if (path.endsWith("/move")) {
					operations.push("move");
					if (failMove) return route.fulfill({ status: 503, json: { error: "ticket-unavailable" } });
					const { status, beforeId } = route.request().postDataJSON();
					ticket.status = status;
					tickets = tickets.filter((value) => value.id !== ticket.id);
					const index = tickets.findIndex((value) => value.id === beforeId);
					tickets.splice(index < 0 ? tickets.length : index, 0, ticket);
				} else if (method === "PATCH") Object.assign(ticket, route.request().postDataJSON());
				return route.fulfill({ json: ticket });
			}
			if (path.endsWith("/branches")) return route.fulfill({ json: [{ name: "main", sha: "a".repeat(40) }] });
			if (path.endsWith("/tree"))
				return route.fulfill({ json: { path: "", head: "a".repeat(40), entries: [], truncated: false } });
			return route.fulfill({ status: 404, json: {} });
		},
	);
	await page.goto("/");
	await page.getByRole("link", { name: "Open Forge", exact: true }).click();
	await page.getByRole("tab", { name: "Tasks", exact: true }).click();
	return {
		operations,
		held: () => held,
		blockReads: () => {
			hold = new Promise<void>((resolve) => {
				release = resolve;
			});
		},
		releaseReads: () => {
			release();
			hold = undefined;
		},
		messages: () => messages,
		stopRequests: () => stopRequests,
		approvals,
		setArchiveFailure: (value: boolean) => {
			failArchive = value;
		},
		failMoves: () => {
			failMove = true;
		},
	};
};

test("ticket archive requires confirmation and removes the card only after success", async ({ page }) => {
	const fixture = await setup(page);
	const card = page.getByRole("button", { name: "FORGE-1 First task", exact: true });
	await card.click();
	const archive = page.getByRole("button", { name: "Archive ticket", exact: true });
	await archive.click();
	const confirmation = page.getByRole("dialog", { name: "Archive FORGE-1?" });
	const cancel = confirmation.getByRole("button", { name: "Cancel", exact: true });
	const confirm = confirmation.getByRole("button", { name: "Archive", exact: true });
	await expect(cancel).toBeFocused();
	await cancel.click();
	await expect(confirmation).toBeHidden();
	await expect(archive).toBeFocused();
	await archive.click();
	await page.keyboard.press("Escape");
	await expect(confirmation).toBeHidden();
	await expect(archive).toBeFocused();
	expect(fixture.operations).toEqual([]);

	fixture.setArchiveFailure(true);
	await archive.click();
	await confirm.click();
	await expect(confirmation.getByRole("alert")).toHaveText(
		"Tickets are unavailable. Retry or check the server logs.",
	);
	fixture.setArchiveFailure(false);
	await confirm.click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(card).toHaveCount(0);
	await expect(page.getByRole("button", { name: "FORGE-2 Second task", exact: true })).toBeVisible();
	expect(fixture.operations).toEqual(["archive", "archive"]);
});

test("board settings save the slider and control pause, stop and resume", async ({ page }) => {
	const fixture = await setup(page);
	const settings = page.getByRole("button", { name: "Board settings", exact: true });
	await settings.click();
	const modal = page.getByRole("dialog", { name: "Board settings" });
	const slider = modal.getByRole("slider", { name: "Max concurrent agents" });
	await expect(slider).toHaveValue("3");
	await slider.focus();
	await slider.press("ArrowRight");
	await modal.getByRole("button", { name: "Save limit" }).click();
	await expect(modal.getByRole("status")).toHaveText("Agent limit saved.");
	await modal.getByRole("button", { name: "Pause new tickets" }).click();
	await expect(modal.getByRole("status")).toHaveText("New tickets are paused.");
	expect(fixture.stopRequests()).toBe(0);
	await modal.getByRole("button", { name: "Stop all agents" }).click();
	await expect(modal.getByRole("alert")).toHaveText(
		"Interruption requested for 2 agents. 1 agent could not be interrupted.",
	);
	expect(fixture.stopRequests()).toBe(1);
	await modal.getByRole("button", { name: "Resume ticket dispatch" }).click();
	await expect(modal.getByRole("status")).toHaveText("Ticket dispatch resumed.");
	await modal.getByRole("button", { name: "Close board settings" }).click();
	await expect(settings).toBeFocused();
	await settings.click();
	await expect(slider).toHaveValue("4");
});

test("ticket sections are keyboard navigable tabs with a labelled active panel", async ({ page }) => {
	await setup(page, false, true);
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	const modal = page.getByRole("dialog", { name: "FORGE-1" });
	const tablist = modal.getByRole("tablist", { name: "Ticket sections" });
	const plan = tablist.getByRole("tab", { name: "Plan" });
	const chat = tablist.getByRole("tab", { name: "Chat" });
	const details = tablist.getByRole("tab", { name: "Details" });
	await expect(plan).toHaveAttribute("aria-selected", "true");
	await plan.focus();
	await plan.press("ArrowRight");
	await expect(chat).toBeFocused();
	await expect(modal.getByRole("tabpanel", { name: "Chat" })).toBeVisible();
	await expect(modal.getByRole("tabpanel")).toHaveCount(1);
	await chat.press("ArrowRight");
	await expect(details).toBeFocused();
	await expect(details).toHaveAttribute("aria-selected", "true");
	await details.press("End");
	await expect(chat).toBeFocused();
	await chat.press("Home");
	await expect(modal.getByRole("tabpanel", { name: "Details" })).toBeVisible();
});

for (const size of [
	{ width: 1280, height: 900 },
	{ width: 820, height: 820 },
	{ width: 390, height: 844 },
]) {
	test(`ticket chat is separate from scope and fits the keyboard viewport at ${size.width}px`, async ({ page }) => {
		await page.setViewportSize(size);
		const fixture = await setup(page, false, true);
		await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
		const panel = page.getByRole("dialog");
		await panel.getByRole("button", { name: "Request changes", exact: true }).click();
		await expect(panel.getByLabel("Message", { exact: true })).toBeVisible();
		await expect(
			panel.getByText("Planning message 0: implement search with tests.", { exact: true }),
		).toBeAttached();
		await panel.getByLabel("Message", { exact: true }).fill("Include filtering");
		await panel.getByRole("button", { name: "Send message", exact: true }).click();
		await expect.poll(fixture.messages).toBe(1);
		await panel.getByRole("tab", { name: "Details", exact: true }).click();
		await expect(panel.getByLabel("Description", { exact: true })).toHaveValue("Scope");
		await panel.getByRole("tab", { name: "Chat", exact: true }).click();
		await page.evaluate(() => {
			Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 440 });
			window.visualViewport!.dispatchEvent(new Event("resize"));
		});
		await expect
			.poll(async () => (await panel.boundingBox())!.y + (await panel.boundingBox())!.height)
			.toBeLessThanOrEqual(441);
		const composer = panel.getByRole("button", { name: "Send message", exact: true });
		expect((await composer.boundingBox())!.y + (await composer.boundingBox())!.height).toBeLessThanOrEqual(440);
		const bounds = (await panel.boundingBox())!;
		if (size.width > 600) expect(bounds.x).toBeGreaterThan(0);
		else expect(bounds.width).toBe(size.width);
		expect(await page.evaluate(() => scrollY === 0 && document.documentElement.scrollHeight <= innerHeight)).toBe(
			true,
		);
		await page.screenshot({ path: `../../artifacts/forge-browser/ticket-chat-${size.width}.png` });
	});
}

test("ticket message drafts survive closing and reopening", async ({ page }) => {
	await setup(page, false, true);
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	await page.getByRole("button", { name: "Request changes", exact: true }).click();
	await page.getByLabel("Message", { exact: true }).fill("Keep this feedback");
	await page.getByRole("button", { name: "Close ticket", exact: true }).click();
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	await page.getByRole("button", { name: "Request changes", exact: true }).click();
	await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this feedback");
});

test("planning history disables execution controls", async ({ page }) => {
	await setup(page, false, true, true);
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
	await page.getByRole("tab", { name: "Planning history", exact: true }).click();
	await expect(page.getByRole("tabpanel", { name: "Planning history" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeDisabled();
});

test("ticket input drafts survive closing and reopening", async ({ page }) => {
	await setup(page, false, true, true);
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	await page.getByLabel("Which files?", { exact: true }).fill("Only search files");
	await page.getByRole("button", { name: "Close ticket", exact: true }).click();
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	await expect(page.getByLabel("Which files?", { exact: true })).toHaveValue("Only search files");
});

test("board writes wait for an in-flight refresh", async ({ page }) => {
	const f = await setup(page);
	await expect(page.getByRole("button", { name: "FORGE-1 First task", exact: true })).toBeVisible();
	f.blockReads();
	await page.getByRole("button", { name: "Refresh board", exact: true }).click();
	await expect.poll(f.held).toBeGreaterThan(0);
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	await page.getByLabel("Status", { exact: true }).selectOption("todo");
	// Give the request transport time to expose an incorrectly concurrent write.
	await page.waitForTimeout(100);
	f.releaseReads();
	await expect.poll(() => f.operations.includes("move")).toBe(true);
	expect(f.operations[0]).toBe("read");
});

for (const size of [
	{ width: 1280, height: 900 },
	{ width: 448, height: 960 },
	{ width: 820, height: 820 },
]) {
	test(`task columns scroll independently with fixed headings at ${size.width}px`, async ({ page }) => {
		await page.setViewportSize(size);
		await setup(page, true);
		await expect(page.getByRole("button", { name: "FORGE-30 Task 30", exact: true })).toHaveCount(1);
		const check = async (height: number) => {
			const board = page.locator(".kanban-columns");
			await expect
				.poll(() => board.evaluate((el) => el.getBoundingClientRect().bottom))
				.toBeLessThanOrEqual(height);
			const rect = (await board.boundingBox())!;
			expect(rect.y + rect.height).toBeGreaterThan(height - 40);
			const draft = page.locator('[data-drop-status="backlog"]');
			const heading = draft.locator(".kanban-column-heading");
			const top = (await heading.boundingBox())!.y;
			await draft.evaluate((el) => {
				el.scrollTop = el.scrollHeight;
			});
			expect((await heading.boundingBox())!.y).toBeCloseTo(top, 0);
			await expect(draft.getByRole("button", { name: "FORGE-30 Task 30", exact: true })).toBeInViewport();
			expect(await page.locator('[data-drop-status="todo"]').evaluate((el) => el.scrollTop)).toBe(0);
			expect(
				await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && scrollY === 0),
			).toBe(true);
		};
		await check(size.height);
		if (size.width < 1000) {
			await page.evaluate(() => {
				Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 480 });
				window.visualViewport!.dispatchEvent(new Event("resize"));
			});
			await check(480);
			await page.getByRole("button", { name: "Create ticket", exact: true }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByLabel("Title", { exact: true }).fill("Keyboard draft");
			const bounds = (await dialog.boundingBox())!;
			expect(bounds.y).toBeGreaterThanOrEqual(0);
			expect(bounds.y + bounds.height).toBeLessThanOrEqual(480);
			await dialog.evaluate((el) => {
				el.scrollTop = el.scrollHeight;
			});
			const create = (await dialog.getByRole("button", { name: "Create", exact: true }).boundingBox())!;
			expect(create.y + create.height).toBeLessThanOrEqual(480);
		}
	});
}

test("create and edit tickets; status menu queues planning and survives reopening", async ({ page }) => {
	await setup(page);
	const boardUrl = page.url();
	const historyLength = await page.evaluate(() => history.length);
	await page.getByRole("button", { name: "Create ticket", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(page).toHaveURL(boardUrl);
	expect(await page.evaluate(() => history.length)).toBe(historyLength);
	await dialog.getByLabel("Title", { exact: true }).fill("New task");
	await dialog.getByLabel("Description", { exact: true }).fill("Simple scope");
	await dialog.getByRole("button", { name: "Create", exact: true }).click();
	await expect(page.getByRole("button", { name: "FORGE-3 New task", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "FORGE-3 New task", exact: true }).click();
	await dialog.getByLabel("Title", { exact: true }).fill("Updated task");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await page.getByRole("button", { name: "FORGE-3 Updated task", exact: true }).click();
	await dialog.getByLabel("Status", { exact: true }).selectOption("todo");
	await expect(dialog.getByLabel("Status", { exact: true })).toHaveValue("todo");
	await dialog.getByRole("button", { name: "Close ticket", exact: true }).click();
	await expect(
		page.getByRole("region", { name: "Ready for development", exact: true }).getByText("Updated task"),
	).toBeAttached();
	await page.reload();
	await expect(page).toHaveURL(`/projects/${projectId}/tasks`);
	await expect(
		page.getByRole("region", { name: "Ready for development", exact: true }).getByText("Updated task"),
	).toBeAttached();
});

test("desktop drop zones reorder cards and move to an empty column; failures preserve the board", async ({ page }) => {
	const fixture = await setup(page);
	await expect(page.getByRole("button", { name: "FORGE-1 First task", exact: true })).toBeVisible();
	await page.screenshot({ path: "../../artifacts/forge-browser/tasks-desktop.png" });
	const handle = page.getByRole("button", { name: "Drag FORGE-2", exact: true });
	const first = page.getByRole("button", { name: "FORGE-1 First task", exact: true });
	await handle.hover();
	await page.mouse.down();
	const rect = (await first.boundingBox())!;
	await page.mouse.move(rect.x + 80, rect.y + 4, { steps: 8 });
	await expect(page.locator(".ticket-drop-placeholder")).toBeVisible();
	await page.mouse.up();
	await expect(
		page.getByRole("region", { name: "Backlog", exact: true }).locator(".ticket-card").first(),
	).toContainText("FORGE-2");
	const ready = page.getByRole("region", { name: "Ready for development", exact: true });
	await handle.hover();
	await page.mouse.down();
	const target = (await ready.boundingBox())!;
	await page.mouse.move(target.x + 100, target.y + 120, { steps: 8 });
	await page.mouse.up();
	await expect(ready.getByText("Second task")).toBeVisible();
	fixture.failMoves();
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	await page.getByLabel("Status", { exact: true }).selectOption("todo");
	await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
	await expect(page.getByLabel("Status", { exact: true })).toHaveValue("backlog");
});

test("drag edge scrolling and cancellation preserve ticket state", async ({ page }) => {
	await page.setViewportSize({ width: 820, height: 820 });
	await setup(page);
	const handle = page.getByRole("button", { name: "Drag FORGE-1", exact: true });
	await handle.hover();
	await page.mouse.down();
	const bounds = (await page.locator(".kanban-columns").boundingBox())!;
	await page.mouse.move(bounds.x + bounds.width - 5, bounds.y + 120);
	await expect
		.poll(() => page.locator(".kanban-columns").evaluate((element) => element.scrollLeft))
		.toBeGreaterThan(100);
	await page.keyboard.press("Escape");
	await page.mouse.up();
	await expect(page.locator(".ticket-drag-preview")).toHaveCount(0);
	await expect(page.locator(".ticket-drop-placeholder")).toHaveCount(0);
	await expect(page.getByRole("region", { name: "Backlog", exact: true }).getByText("First task")).toBeAttached();
	await handle.scrollIntoViewIfNeeded();
	await handle.hover();
	await page.mouse.down();
	await page.mouse.move(5, 5);
	await page.mouse.up();
	await expect(page.getByRole("region", { name: "Backlog", exact: true }).getByText("First task")).toBeAttached();
});

test("mobile touch drag and status dropdown work without widening the page", async ({ browser }) => {
	const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
	const page = await context.newPage();
	await setup(page);
	const handle = (await page.getByRole("button", { name: "Drag FORGE-1", exact: true }).boundingBox())!;
	const ready = (await page.getByRole("region", { name: "Ready for development", exact: true }).boundingBox())!;
	const client = await context.newCDPSession(page);
	const x = handle.x + handle.width / 2;
	const y = handle.y + handle.height / 2;
	await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
	await client.send("Input.dispatchTouchEvent", {
		type: "touchMove",
		touchPoints: [{ x: Math.min(ready.x + 40, 370), y: ready.y + 130 }],
	});
	await expect(page.locator(".ticket-drop-placeholder")).toBeVisible();
	await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await expect(
		page.getByRole("region", { name: "Ready for development", exact: true }).getByText("First task"),
	).toBeAttached();
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	await expect(page.getByLabel("Status", { exact: true })).toHaveValue("todo");
	await page.screenshot({ path: "../../artifacts/forge-browser/tasks-mobile.png" });
	await page.getByRole("button", { name: "Close ticket", exact: true }).click();
	await page.screenshot({ path: "../../artifacts/forge-browser/tasks-mobile-board.png" });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await context.close();
});

test("a plan needs attention on the four-column board and approval submits the displayed revision", async ({
	page,
}) => {
	const f = await setup(page, false, true);
	await expect(page.locator(".kanban-column h3")).toHaveText([
		"Backlog",
		"Ready for development",
		"In progress",
		"Done",
	]);
	const card = page.locator('[data-ticket-id="FORGE-1"]');
	await expect(card.getByRole("img", { name: "Needs attention" })).toHaveText("!");
	await card.getByRole("button", { name: "FORGE-1 First task" }).click();
	const panel = page.getByRole("dialog");
	await expect(panel.getByRole("heading", { name: "Search plan" })).toBeVisible();
	await expect(panel.getByRole("listitem")).toHaveText("Add filtering.");
	await expect(panel.getByText("unsafe")).toHaveCount(0);
	await panel.getByRole("button", { name: "Approve", exact: true }).click();
	await expect.poll(() => f.approvals).toEqual([{ revision: 1 }]);
	await panel.getByRole("button", { name: "Close ticket" }).click();
	await expect(card.getByRole("img", { name: "Needs attention" })).toHaveCount(0);
});
