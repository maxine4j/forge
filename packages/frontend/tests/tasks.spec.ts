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
		agentStatus?: "queued" | "working";
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
				return route.fulfill({
					json: {
						settings: boardSettings,
						requested: stopRequests === 1 ? 2 : 0,
						recovered: 1,
						failed: stopRequests === 1 ? 1 : 0,
					},
				});
			}
			if (path.endsWith("/workflow") || path.endsWith("/messages") || path.endsWith("/approve")) {
				if (path.endsWith("/messages")) messages++;
				if (path.endsWith("/approve")) {
					approvals.push(route.request().postDataJSON());
					approved = true;
					delete tickets[0]!.needsAttention;
					tickets[0]!.agentStatus = "queued";
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
						contextWindow: { used: 32000, max: 128000 },
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
		setAgentStatus: (agentStatus?: "queued" | "working", needsAttention?: true) => {
			tickets[0]!.status = "in-progress";
			tickets[0]!.agentStatus = agentStatus;
			tickets[0]!.needsAttention = needsAttention;
		},
		setTitle: (title: string) => {
			tickets[0]!.title = title;
		},
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

test("agent icons poll from queued to working to idle, and attention takes precedence", async ({ page }) => {
	test.setTimeout(60_000);
	const fixture = await setup(page);
	const card = page.locator('[data-ticket-id="FORGE-1"]');
	fixture.setAgentStatus("queued");
	const clock = card.getByRole("img", { name: "Agent queued" });
	await expect(clock).toBeVisible();
	await expect(clock.locator("title")).toHaveText("Agent queued");
	const bounds = await card.locator(".ticket-open").boundingBox();
	const icon = await clock.boundingBox();
	expect(icon!.width).toBe(16);
	expect(icon!.height).toBe(16);
	expect(bounds!.x + bounds!.width - icon!.x - icon!.width).toBeCloseTo(12, 0);
	expect(bounds!.y + bounds!.height - icon!.y - icon!.height).toBeCloseTo(12, 0);
	fixture.setAgentStatus("working");
	const spinner = card.getByRole("img", { name: "Agent working" });
	await expect(spinner).toBeVisible();
	await expect(clock).toHaveCount(0);
	await expect(spinner).toHaveCSS("animation-name", "ticket-agent-spin");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect(spinner).toHaveCSS("animation-name", "none");
	fixture.setAgentStatus("working", true);
	const dot = card.getByRole("img", { name: "Action required" });
	await expect(dot).toBeVisible();
	await expect(dot).toHaveAttribute("title", "Action required");
	await expect(card.getByRole("img")).toHaveCount(1);
	await expect(card).toHaveCSS("background-color", "rgb(81, 43, 18)");
	expect(await dot.boundingBox()).toEqual(icon);
	const paint = await dot.evaluate((element) => {
		const style = getComputedStyle(element, "::before");
		return [style.width, style.height, style.backgroundColor, style.borderRadius];
	});
	expect(paint).toEqual(["8px", "8px", "rgb(255, 77, 79)", "50%"]);
	await card.locator(".ticket-open").focus();
	await page.keyboard.press("Tab");
	await page.keyboard.press("Shift+Tab");
	await expect(card.locator(".ticket-open")).toBeFocused();
	await expect(card.locator(".ticket-open")).toHaveCSS("outline-style", "solid");
	await card.hover();
	await expect(card).toHaveCSS("background-color", "rgb(99, 54, 21)");
	await expect(card.locator(".ticket-key")).toHaveCSS("color", "rgb(242, 201, 165)");
	await page.mouse.move(0, 0);
	await expect(spinner).toHaveCount(0);
	for (const status of ["working", "queued", undefined] as const) {
		fixture.setAgentStatus(status, true);
		await expect(dot).toBeVisible({ timeout: 10_000 });
		fixture.setAgentStatus(status);
		await expect(dot).toHaveCount(0);
		await expect(card).toHaveCSS("background-color", "rgb(33, 38, 45)");
		await expect(card.getByRole("img")).toHaveCount(status ? 1 : 0);
	}
	fixture.setAgentStatus();
	await expect(card.getByRole("img")).toHaveCount(0);
	fixture.setAgentStatus("queued");
	await expect(clock).toBeVisible();
	await card.getByRole("button", { name: "Drag FORGE-1", exact: true }).hover();
	await page.mouse.down();
	await page.mouse.move(bounds!.x + 80, bounds!.y + 10, { steps: 8 });
	await expect(page.locator(".ticket-drag-preview")).toBeVisible();
	await page.keyboard.press("Escape");
	await page.mouse.up();
	await expect(page.locator(".ticket-drag-preview")).toHaveCount(0);
	await expect(clock).toBeVisible();
	await clock.click();
	await expect(page.getByRole("dialog")).toBeVisible();
});

test("mobile agent icons reserve room for long titles and metadata", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await page.emulateMedia({ reducedMotion: "reduce" });
	const fixture = await setup(page);
	fixture.setTitle(
		"Long title with many words to wrap across the narrow mobile ticket card and preserve room for the status icon",
	);
	fixture.setAgentStatus("working");
	const card = page.locator('[data-ticket-id="FORGE-1"]');
	const spinner = card.getByRole("img", { name: "Agent working" });
	await expect(spinner).toBeVisible();
	const icon = await spinner.boundingBox();
	for (const selector of [".ticket-title", ".ticket-key"]) {
		const content = await card.locator(selector).boundingBox();
		expect(content!.x + content!.width).toBeLessThan(icon!.x);
	}
	const bounds = await card.locator(".ticket-open").boundingBox();
	expect(bounds!.x + bounds!.width - icon!.x - icon!.width).toBeCloseTo(12, 0);
	expect(bounds!.y + bounds!.height - icon!.y - icon!.height).toBeCloseTo(12, 0);
	fixture.setAgentStatus("working", true);
	const dot = card.getByRole("img", { name: "Action required" });
	await expect(dot).toBeVisible();
	expect(await dot.boundingBox()).toEqual(icon);
	await expect(card.getByRole("img")).toHaveCount(1);
	await expect(card).toHaveCSS("background-color", "rgb(81, 43, 18)");
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
		"Interruption requested for 2 agents. Slots recovered: 1. 1 execution remains unresolved. Retry Stop all agents to reconcile again.",
	);
	expect(fixture.stopRequests()).toBe(1);
	await expect(modal.getByRole("button", { name: "Stop all agents" })).toBeEnabled();
	await modal.getByRole("button", { name: "Stop all agents" }).click();
	await expect.poll(fixture.stopRequests).toBe(2);
	await expect(modal.getByRole("status")).toHaveText("Interruption requested for 0 agents. Slots recovered: 1.");
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
	const chat = tablist.getByRole("tab", { name: "Chat" });
	const details = tablist.getByRole("tab", { name: "Details" });
	const cost = tablist.getByRole("tab", { name: "Cost" });
	await expect(tablist.getByRole("tab")).toHaveCount(3);
	await expect(chat).toHaveAttribute("aria-selected", "true");
	await details.focus();
	await details.press("ArrowRight");
	await expect(chat).toBeFocused();
	await expect(modal.getByRole("tabpanel", { name: "Chat" })).toBeVisible();
	await expect(modal.getByRole("tabpanel")).toHaveCount(1);
	await chat.press("ArrowRight");
	await expect(cost).toBeFocused();
	await cost.press("ArrowRight");
	await expect(details).toBeFocused();
	await expect(details).toHaveAttribute("aria-selected", "true");
	await details.press("End");
	await expect(cost).toBeFocused();
	await cost.press("Home");
	await expect(modal.getByRole("tabpanel", { name: "Details" })).toBeVisible();
});

test("ticket chat shows the current context window", async ({ page }) => {
	await setup(page, false, true);
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	const modal = page.getByRole("dialog", { name: "FORGE-1" });
	const ring = modal.getByRole("button", { name: "Context window" });
	await expect(ring).toBeVisible();
	await ring.focus();
	await expect(modal.getByRole("tooltip")).toContainText("32,000 of 128,000 tokens");
	await expect(modal.getByRole("tooltip")).toContainText("25% used");
});

test("ticket Cost shows this ticket's estimates and token counts", async ({ page }) => {
	await setup(page, false, true);
	const totals = { input: 1800, cached: 600, output: 200, turns: 2 };
	await page.route(`**/api/projects/${projectId}/cost`, (route) =>
		route.fulfill({
			json: {
				since: createdAt,
				monthlyAud: 30,
				audPerUsd: 1.44,
				exchangeDate: "2026-11-10",
				totals,
				phases: [],
				days: [],
				tickets: [
					{
						...totals,
						id: "FORGE-1",
						title: "First task",
						subscriptionAud: 0.015,
						apiAud: 0.09,
						untimedTurns: 0,
						unpricedTurns: 1,
					},
					{ ...totals, id: "FORGE-2", title: "Second task", apiAud: 1.99, untimedTurns: 0, unpricedTurns: 0 },
				],
			},
		}),
	);
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	const modal = page.getByRole("dialog", { name: "FORGE-1" });
	await expect(modal.getByRole("tab", { name: "Cost" })).toBeVisible();
	await modal.getByRole("tab", { name: "Cost" }).click();
	const cost = modal.getByRole("tabpanel", { name: "Cost" });
	for (const value of ["1,800", "600", "200", "A$0.015", "A$0.09", "1 turn missing pricing"])
		await expect(cost.getByText(value, { exact: true })).toBeVisible();
	await expect(cost.getByText("A$1.99")).toHaveCount(0);
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
		await panel.getByRole("tab", { name: "Chat", exact: true }).click();
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
	await page.getByRole("tab", { name: "Chat", exact: true }).click();
	await page.getByLabel("Message", { exact: true }).fill("Keep this feedback");
	await page.getByRole("button", { name: "Close ticket", exact: true }).click();
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	await page.getByRole("tab", { name: "Chat", exact: true }).click();
	await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this feedback");
});

test("combined chat has one set of live execution controls", async ({ page }) => {
	await setup(page, false, true, true);
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toHaveCount(1);
	await expect(page.getByRole("tab", { name: "Planning history", exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(1);
	await expect(page.getByLabel("Message", { exact: true })).toHaveCount(1);
});

test("one ticket timeline retains revisions, approval, drafts and history through steering and completion", async ({
	page,
}) => {
	await setup(page, false, true);
	const planner = "123e4567-e89b-42d3-a456-426614174010";
	const implementer = "123e4567-e89b-42d3-a456-426614174011";
	let phase = "planning";
	let state = "idle";
	let revision = 1;
	let started = false;
	let done = false;
	let uncertain = false;
	let resumes = 0;
	let reject = false;
	const submissions: unknown[] = [];
	const plans = [{ id: "plan-1", role: "assistant", kind: "plan", text: "# Initial plan\n\nAdd **search**." }];
	const activity: { id: string; role: string; text: string }[] = [];
	const workflow = () => ({
		ticketId: "FORGE-1",
		plannerId: planner,
		...(started ? { implementerId: implementer } : {}),
		phase,
		state,
		mergeAttempts: 0,
		plan: { revision, text: plans[revision - 1]!.text },
		...(phase !== "planning" ? { approvedRevision: revision } : {}),
	});
	await page.route("**/api/tickets/FORGE-1/{workflow,messages,approve}", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/approve")) {
			expect(route.request().postDataJSON()).toEqual({ revision: 2 });
			phase = "implementation";
			state = "queued";
		}
		if (path.endsWith("/messages")) {
			const input = route.request().postDataJSON();
			submissions.push(input);
			if (reject) return route.fulfill({ status: 409, json: { error: "ticket-conflict" } });
			if (phase === "planning") state = "queued";
			else activity.push({ id: `steer-${submissions.length}`, role: "user", text: input.text });
		}
		return route.fulfill({ json: workflow() });
	});
	await page.route("**/api/agents/**", async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path.endsWith("/events"))
			return route.fulfill({ contentType: "text/event-stream", body: "data: changed\n\n" });
		const historical = path.includes(planner);
		if (!historical && path.endsWith("/resume")) {
			uncertain = false;
			resumes++;
		}
		return route.fulfill({
			json: {
				thread: {
					id: historical ? planner : implementer,
					projectId,
					workspaceId: planner,
					title: "Ticket",
					createdAt,
					status: historical
						? phase === "planning" && state === "running"
							? "running"
							: "completed"
						: uncertain
							? "uncertain"
							: done
								? "completed"
								: "running",
					turnId: historical ? "plan-turn" : "implementation-turn",
				},
				items: historical
					? [
							...Array.from({ length: 25 }, (_, i) => ({
								id: `old-${i}`,
								role: "assistant",
								text: `Retained planning message ${i}`,
							})),
							...plans,
						]
					: activity,
				// A stale planner callback must never acquire live controls in the combined view.
				requests:
					historical && phase !== "planning"
						? [{ id: "historical-request", kind: "command", description: "Old approval", questions: [] }]
						: [],
				truncated: false,
			},
		});
	});
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	const modal = page.getByRole("dialog", { name: "FORGE-1", exact: true });
	const message = modal.getByLabel("Message", { exact: true });
	const send = modal.getByRole("button", { name: "Send message", exact: true });
	await expect(modal.getByRole("tab")).toHaveCount(3);
	await expect(modal.getByRole("tab", { name: "Chat", exact: true })).toHaveAttribute("aria-selected", "true");
	await expect(modal.getByRole("heading", { name: "Initial plan" })).toBeVisible();
	await message.fill("Include filtering");
	await message.press("Enter");
	await expect.poll(() => submissions.length).toBe(1);
	await expect(modal.getByRole("button", { name: "Approve plan" })).toHaveCount(0);
	state = "running";
	await expect(send).toBeDisabled();
	plans.push({ id: "plan-2", role: "assistant", kind: "plan", text: "# Streaming revision\n\nAdd **filtering**." });
	await expect(modal.getByRole("heading", { name: "Streaming revision" })).toBeAttached();
	await expect(modal.getByRole("button", { name: "Approve plan" })).toHaveCount(0);
	revision = 2;
	plans[1]!.text = "# Revised plan\n\nAdd **filtering**.";
	state = "idle";
	await expect(modal.getByRole("button", { name: "Approve plan" })).toBeVisible();
	await expect(modal.getByRole("heading", { name: "Initial plan" })).toBeAttached();
	await message.fill("Retain this draft across approval");
	const history = modal.getByLabel("Conversation history", { exact: true });
	await history.evaluate((element) => {
		element.scrollTop = 80;
	});
	await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(80);
	const latest = modal.getByRole("button", { name: "Scroll to latest", exact: true });
	await expect(latest).toBeVisible();
	await expect(latest).not.toHaveClass(/agent-scroll-unseen/);
	await page.waitForTimeout(1200);
	await expect(latest).not.toHaveClass(/agent-scroll-unseen/);
	expect(await history.evaluate((element) => element.scrollTop)).toBe(80);
	await modal.getByRole("tab", { name: "Details", exact: true }).click();
	await modal.getByRole("tab", { name: "Chat", exact: true }).click();
	await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(80);
	await modal.getByRole("button", { name: "Approve plan" }).click();
	await expect(modal.getByRole("separator", { name: "Plan approved · Implementation" })).toHaveCount(1);
	await expect(modal.getByText("Implementation: queued", { exact: true })).toBeVisible();
	await expect(send).toBeDisabled();
	await expect(message).toHaveValue("Retain this draft across approval");
	await history.evaluate((element) => {
		element.scrollTop = 80;
	});
	started = true;
	state = "running";
	activity.push({ id: "working", role: "assistant", text: "Implementing filtering" });
	await expect(modal.getByRole("button", { name: "Interrupt", exact: true })).toBeVisible();
	await expect.poll(() => history.evaluate((element) => element.scrollTop)).toBe(80);
	await expect(latest).toHaveClass(/agent-scroll-unseen/);
	await expect(message).toHaveValue("Retain this draft across approval");
	await expect(message).toHaveCount(1);
	await expect(history).toHaveCount(1);
	await expect(modal.getByRole("separator")).toHaveCount(1);
	await expect(modal.getByText("Retained planning message 0", { exact: true })).toBeAttached();
	await expect(modal.getByRole("button", { name: "Allow once" })).toHaveCount(0);
	reject = true;
	await send.click();
	await expect(modal.getByRole("alert")).toBeVisible();
	await expect(message).toHaveValue("Retain this draft across approval");
	await modal.getByRole("button", { name: "Close ticket" }).click();
	await page.getByRole("button", { name: "FORGE-1 First task", exact: true }).click();
	await expect(message).toHaveValue("Retain this draft across approval");
	reject = false;
	await send.click();
	await expect(message).toHaveValue("");
	expect(submissions.at(-1)).toEqual({
		text: "Retain this draft across approval",
		expectedTurnId: "implementation-turn",
	});
	await expect(modal.getByText("Retain this draft across approval", { exact: true })).toBeAttached();
	await expect(modal.getByText("Retain this draft across approval", { exact: true })).toBeInViewport();
	const submitted = submissions.length;
	const recovered = resumes;
	await message.fill("Keep this draft through recovery");
	uncertain = true;
	await expect.poll(() => resumes).toBeGreaterThan(recovered);
	await expect(message).toHaveValue("Keep this draft through recovery");
	expect(submissions).toHaveLength(submitted);
	state = "merge-queued";
	done = true;
	await expect(send).toBeDisabled();
	await page.route(`**/api/projects/${projectId}/tickets`, (route) =>
		route.fulfill({
			json: [{ id: "FORGE-1", projectId, title: "First task", description: "Scope", status: "done", createdAt }],
		}),
	);
	await expect(message).toBeDisabled();
	await expect(modal.getByRole("button", { name: "Interrupt" })).toHaveCount(0);
	await expect(modal.getByRole("heading", { name: "Revised plan" })).toBeAttached();
	await expect(modal.getByRole("separator")).toHaveCount(1);
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
	const dot = card.getByRole("img", { name: "Action required" });
	await expect(dot).toBeVisible();
	await card.getByRole("button", { name: "FORGE-1 First task" }).click();
	await page.getByRole("button", { name: "Close ticket" }).click();
	await expect(dot).toBeVisible();
	await card.getByRole("button", { name: "FORGE-1 First task" }).click();
	const panel = page.getByRole("dialog");
	await expect(panel.getByRole("heading", { name: "Search plan" })).toBeVisible();
	await expect(panel.getByRole("listitem")).toHaveText("Add filtering.");
	await expect(panel.getByText("unsafe")).toHaveCount(0);
	await panel.getByRole("button", { name: "Approve plan", exact: true }).click();
	await expect.poll(() => f.approvals).toEqual([{ revision: 1 }]);
	await panel.getByRole("button", { name: "Close ticket" }).click();
	await expect(dot).toHaveCount(0);
	await expect(card.getByRole("img", { name: "Agent queued" })).toBeVisible();
	await expect(card).not.toHaveClass(/needs-attention/);
});
