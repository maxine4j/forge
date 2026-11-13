import type { AgentView } from "@forge/contracts/agents";
import { defaultForgeSettings, type ForgeSettings } from "@forge/contracts/settings";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

const projectId = "123e4567-e89b-42d3-a456-426614174000";
const createdAt = "2026-11-03T00:00:00.000Z";
const setup = async (page: Page, initialItems: AgentView["items"] = []) => {
	const views: AgentView[] = [];
	const writes: string[] = [];
	const replies: unknown[] = [];
	let fail = false;
	let reads = 0;
	await page.addInitScript(() => {
		class ControlledEvents {
			onmessage: (() => void) | null = null;
			onopen: (() => void) | null = null;
			onerror: (() => void) | null = null;
			constructor() {
				window.addEventListener("agent-event", this.notify);
				queueMicrotask(() => this.onopen?.());
			}
			notify = (event: Event) => {
				const type = (event as CustomEvent<string>).detail;
				if (type === "error") this.onerror?.();
				else if (type === "open") this.onopen?.();
				else this.onmessage?.();
			};
			close() {
				window.removeEventListener("agent-event", this.notify);
			}
		}
		Object.defineProperty(window, "EventSource", { value: ControlledEvents });
	});
	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const path = new URL(route.request().url()).pathname;
			const method = route.request().method();
			if (method !== "GET") writes.push(path);
			if (path === "/api/projects")
				return route.fulfill({ json: [{ id: projectId, name: "Forge", status: "ready", createdAt }] });
			if (path === "/api/accounts")
				return route.fulfill({
					json: {
						codex: { connection: "available", login: { state: "idle" } },
						github: { connection: "available", login: { state: "idle" } },
					},
				});
			if (path.endsWith("/agents")) {
				if (method === "POST") {
					if (fail) return route.fulfill({ status: 503, json: { error: "agent-unavailable" } });
					const id = `123e4567-e89b-42d3-a456-${String(426614174001 + views.length)}`;
					const view: AgentView = {
						thread: {
							id,
							projectId,
							workspaceId: id,
							title: route.request().postDataJSON().title,
							createdAt,
							status: "idle",
						},
						items: [...initialItems],
						requests: [],
						truncated: false,
					};
					views.push(view);
					return route.fulfill({ status: 201, json: view });
				}
				return route.fulfill({ json: views.map((view) => view.thread) });
			}
			if (path.startsWith("/api/agents/")) {
				const view = views.find((value) => value.thread.id === path.split("/")[3])!;
				if (path.endsWith("/options"))
					return route.fulfill({
						json: {
							models: [
								{
									id: "test-model",
									name: "Test model",
									isDefault: true,
									supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
									defaultReasoningEffort: "high",
								},
								{ id: "other-model", name: "Other model", isDefault: false },
							],
							skills: [
								{ name: "review", description: "Review changes" },
								{ name: "release", description: "Prepare release" },
							],
						},
					});
				if (path.endsWith("/files")) return route.fulfill({ json: ["src/main.ts", "src/app.tsx"] });
				if (method === "GET") {
					reads++;
					return route.fulfill({ json: view });
				}
				if (fail) return route.fulfill({ status: 503, json: { error: "agent-unavailable" } });
				if (path.endsWith("/messages")) {
					view.items.push({
						id: `user-${writes.length}`,
						role: "user",
						text: route.request().postDataJSON().text,
					});
					view.thread.status = "running";
					view.thread.turnId = "turn-1";
				}
				if (path.endsWith("/interrupt")) view.thread.status = "interrupted";
				if (path.endsWith("/resume")) {
					if (view.thread.status === "uncertain") {
						view.thread.status = "completed";
						view.items = [{ id: "history", role: "assistant", text: "Recovered history" }];
					}
				}
				if (path.endsWith("/replies")) {
					replies.push(route.request().postDataJSON());
					view.requests = [];
					view.thread.status = "running";
				}
				return route.fulfill({ json: view });
			}
			if (path.endsWith("/branches")) return route.fulfill({ json: [{ name: "main", sha: "a".repeat(40) }] });
			if (path.endsWith("/tree"))
				return route.fulfill({ json: { path: "", head: "a".repeat(40), entries: [], truncated: false } });
			return route.fulfill({ status: 404, json: {} });
		},
	);
	await page.goto("/repos");
	await page.getByRole("link", { name: "Open Forge", exact: true }).click();
	await page.getByRole("tab", { name: "Agents", exact: true }).click();
	const create = async () => {
		const count = views.length;
		const back = page.getByRole("button", { name: "Back to chats", exact: true });
		if (await back.isVisible()) await back.click();
		await page.getByRole("button", { name: "Create chat", exact: true }).click();
		await expect.poll(() => views.length).toBe(count + 1);
		await expect(page).toHaveURL(new RegExp(`/agents/${views.at(-1)!.thread.id}$`));
		await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
	};
	const event = async (type = "changed") =>
		page.evaluate((detail) => window.dispatchEvent(new CustomEvent("agent-event", { detail })), type);
	return {
		views,
		writes,
		replies,
		create,
		event,
		reads: () => reads,
		fail: (value: boolean) => {
			fail = value;
		},
	};
};

test("composer selects model and permissions, completes skills/files, and sends with Enter", async ({ page }) => {
	const fixture = await setup(page);
	await fixture.create();
	const message = page.getByRole("textbox", { name: "Message", exact: true });
	await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("other-model");
	await page.getByRole("combobox", { name: "Permissions", exact: true }).selectOption("approve-for-me");
	await message.fill("Use $rev");
	await expect(page.getByRole("option", { name: /review.*Review changes/ })).toBeVisible();
	await message.press("Tab");
	await expect(message).toHaveValue("Use $review ");
	await message.press("End");
	await message.press("Control+Enter");
	await expect(message).toHaveValue("Use $review \n");
	await message.press("Meta+Enter");
	await expect(message).toHaveValue("Use $review \n\n");
	await message.press("@");
	await expect(page.getByRole("option", { name: "src/main.ts", exact: true })).toBeVisible();
	await message.press("ArrowDown");
	await message.press("Tab");
	await expect(message).toHaveValue("Use $review \n\n@src/app.tsx ");
	const request = page.waitForRequest((request) => request.url().endsWith("/messages"));
	await message.press("Enter");
	expect((await request).postDataJSON()).toMatchObject({
		model: "other-model",
		permissions: "approve-for-me",
		text: "Use $review \n\n@src/app.tsx ",
	});
	await expect(message).toHaveValue("");
});

test("default model can replace an explicit model and completion dismisses without submitting", async ({ page }) => {
	const fixture = await setup(page);
	await fixture.create();
	const message = page.getByRole("textbox", { name: "Message", exact: true });
	await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("other-model");
	await page.getByRole("combobox", { name: "Model", exact: true }).selectOption({ label: "Test model" });
	await message.fill("$rev");
	await expect(page.getByRole("listbox", { name: "Skills" })).toBeVisible();
	await message.press("Escape");
	await expect(page.getByRole("listbox", { name: "Skills" })).toHaveCount(0);
	const request = page.waitForRequest((request) => request.url().endsWith("/messages"));
	await message.press("Enter");
	expect((await request).postDataJSON()).toMatchObject({ model: "test-model", permissions: "ask" });
});

test("standalone thinking uses catalog levels and resets on incompatible model changes", async ({ page }) => {
	const fixture = await setup(page);
	await fixture.create();
	const thinking = page.getByRole("combobox", { name: "Thinking level", exact: true });
	await thinking.selectOption("high");
	await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("other-model");
	await expect(thinking).toHaveValue("");
	await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("");
	await thinking.selectOption("high");
	await page.getByRole("textbox", { name: "Message", exact: true }).fill("Think carefully");
	const request = page.waitForRequest((request) => request.url().endsWith("/messages"));
	await page.getByRole("button", { name: "Send message", exact: true }).click();
	expect((await request).postDataJSON()).toMatchObject({ reasoningEffort: "high" });
	expect((await request).postDataJSON()).not.toHaveProperty("model");
});

test("Config changes refresh the default labels in an open chat and preserve its draft", async ({ page }) => {
	const fixture = await setup(page);
	let settings: ForgeSettings = { ...defaultForgeSettings };
	const options = {
		models: [
			{ id: "test-model", name: "Test model", isDefault: true },
			{
				id: "other-model",
				name: "Other model",
				isDefault: false,
				supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
			},
		],
		skills: [],
	};
	await page.route("**/api/settings", (route) => {
		if (route.request().method() === "PUT") settings = route.request().postDataJSON();
		return route.fulfill({ json: settings });
	});
	await page.route("**/api/settings/model-options", (route) => route.fulfill({ json: options }));
	await page.route("**/api/agents/*/options", (route) =>
		route.fulfill({
			json: {
				...options,
				defaultModel: settings.defaultAgentModel,
				defaultReasoningEffort: settings.defaultAgentReasoningEffort,
			},
		}),
	);
	await fixture.create();
	const model = page.getByRole("combobox", { name: "Model", exact: true });
	const thinking = page.getByRole("combobox", { name: "Thinking level", exact: true });
	const message = page.getByRole("textbox", { name: "Message", exact: true });
	await expect(model.locator("option:checked")).toHaveText("Default model (Test model)");
	await message.fill("Keep this draft");
	await page.getByRole("link", { name: "Config", exact: true }).click();
	await page.getByLabel("Default model", { exact: true }).selectOption("other-model");
	await page.getByLabel("Default thinking", { exact: true }).selectOption("high");
	await page.getByRole("button", { name: "Save settings" }).click();
	await expect(page.getByRole("status")).toHaveText("Settings saved.");
	await page.goBack();
	await expect(model.locator("option:checked")).toHaveText("Default model (Other model)");
	await expect(thinking.locator("option:checked")).toHaveText("Default thinking (high)");
	await expect(message).toHaveValue("Keep this draft");
});

test("consecutive tools share a collapsed group with statuses and agent messages have no bubbles", async ({ page }) => {
	const fixture = await setup(page);
	await fixture.create();
	fixture.views[0]!.items = [
		{ id: "u", role: "user", text: "Inspect changes" },
		{ id: "a", role: "assistant", text: "I’ll inspect the changed files." },
		{ id: "t1", role: "activity", title: "git status", text: "Clean", status: "completed" },
		{ id: "t2", role: "activity", title: "pnpm test", text: "Running tests", status: "running" },
	];
	await fixture.event();
	const group = page.locator(".agent-tool-group");
	await expect(group).toHaveCount(1);
	await expect(group).not.toHaveAttribute("open");
	await group.locator("summary").first().click();
	await expect(group.getByText("git status", { exact: true })).toBeVisible();
	await expect(group.getByText("Completed", { exact: true })).toBeVisible();
	await expect(group.locator('.agent-activity[data-status="running"]')).toHaveCount(1);
	await expect(page.locator(".agent-message-assistant")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await page.screenshot({ path: "../../artifacts/forge-browser/agents-codex-desktop.png" });
});

test("Agents has one compact creation button and no redundant headings or title field", async ({ page }) => {
	const fixture = await test.step("Open Agents", () => setup(page));
	await expect(page.getByRole("button", { name: "Create chat", exact: true })).toBeVisible();
	await test.step("No redundant heading", async () => {
		await expect(page.getByRole("heading", { name: "Agents", exact: true })).toHaveCount(0);
	});
	await expect(page.getByLabel("Chat title", { exact: true })).toHaveCount(0);
	await fixture.create();
	await expect(page.getByRole("region", { name: "Chat conversation" }).getByRole("heading")).toHaveCount(0);
	expect(fixture.views[0]!.thread.title).toBe("Chat 1");
});

test("chat shows guidance when an inference request fails", async ({ page }) => {
	const fixture = await setup(page);
	await fixture.create();
	const view = fixture.views.at(0)!;
	view.thread.status = "failed";
	view.turnFailure = "provider-request";
	await fixture.event();
	await expect(page.getByRole("alert")).toContainText("Check that Forge can reach the inference endpoint");
	await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeEnabled();
});

test("independent chats retain drafts and running activity across tabs and reopening", async ({ page }) => {
	const fixture = await setup(page);
	await fixture.create();
	await page.getByRole("textbox", { name: "Message", exact: true }).fill("Inspect this project");
	await page.getByRole("button", { name: "Send message", exact: true }).click();
	await expect(page.getByText("Inspect this project", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeEnabled();
	await fixture.create();
	const secondUrl = page.url();
	expect(new URL(secondUrl).pathname).toBe(`/repos/${projectId}/agents/${fixture.views[1]!.thread.id}`);
	await page.getByRole("textbox", { name: "Message", exact: true }).fill("Second draft");
	for (const destination of ["Tasks", "Costs", "Config"]) {
		await page.getByRole("link", { name: destination, exact: true }).click();
		await page.goBack();
		await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Second draft");
	}
	await page.getByRole("button", { name: "Open chat Chat 1", exact: true }).click();
	fixture.views[0]!.items.push(
		{ id: "answer", role: "assistant", text: "I found the entry point." },
		{ id: "tool", role: "activity", text: "git status\nClean" },
	);
	await fixture.event();
	await expect(page.getByText("I found the entry point.", { exact: true })).toBeVisible();
	await page.screenshot({ path: "../../artifacts/forge-browser/agents-desktop.png" });
	await page.getByRole("button", { name: "Interrupt", exact: true }).click();
	await expect(page.getByText("interrupted", { exact: true }).last()).toBeVisible();
	await page.getByRole("tab", { name: "Code", exact: true }).click();
	await page.getByRole("tab", { name: "Agents", exact: true }).click();
	await page.getByRole("button", { name: "Open chat Chat 2", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Second draft");
	await page.reload();
	await expect(page).toHaveURL(secondUrl);
	await expect(page.getByRole("button", { name: "Open chat Chat 2", exact: true })).toHaveAttribute(
		"aria-current",
		"true",
	);
	await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("");
	await page.getByRole("button", { name: "Open chat Chat 1", exact: true }).click();
	await expect(page.getByText("I found the entry point.", { exact: true })).toBeVisible();
	await page.goBack();
	await expect(page.getByRole("button", { name: "Open chat Chat 2", exact: true })).toHaveAttribute(
		"aria-current",
		"true",
	);
	await page.goForward();
	await expect(page.getByRole("button", { name: "Open chat Chat 1", exact: true })).toHaveAttribute(
		"aria-current",
		"true",
	);
});

test("unknown chat deep links stay in their project and never create or resume a chat", async ({ page }) => {
	const fixture = await setup(page);
	await fixture.create();
	const writes = fixture.writes.length;
	await page.goto(`/repos/${projectId}/agents/123e4567-e89b-42d3-a456-426614174099`);
	await expect(page.getByRole("heading", { name: "Chat unavailable", exact: true })).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveCount(0);
	expect(fixture.writes).toHaveLength(writes);
});

test("failed sends keep drafts; reconnect recovers history without replaying input", async ({ page }) => {
	const fixture = await setup(page);
	await fixture.create();
	fixture.fail(true);
	await page.getByLabel("Message", { exact: true }).fill("Keep this draft");
	await page.getByRole("button", { name: "Send message", exact: true }).click();
	await expect(page.getByRole("alert")).toContainText("Chat unavailable");
	await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this draft");
	const writes = fixture.writes.length;
	await fixture.event("error");
	await expect(page.getByText("Reconnecting to live updates…", { exact: true })).toBeVisible();
	fixture.views[0]!.thread.status = "uncertain";
	fixture.fail(false);
	const reads = fixture.reads();
	await fixture.event("open");
	await expect.poll(fixture.reads).toBeGreaterThan(reads);
	await expect(page.getByText("Recovered history", { exact: true })).toBeVisible();
	expect(fixture.writes.slice(writes)).toEqual([`/api/agents/${fixture.views[0]!.thread.id}/resume`]);
	await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this draft");
	await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
});

test("Agents opens the first chat and loads only selected histories without uncertain labels", async ({ page }) => {
	const fixture = await setup(page);
	await fixture.create();
	await fixture.create();
	// Unmount the old selected chat before changing runtime state, so its pending
	// recovery cannot race the new page's first-chat selection.
	await page.goto("/repos");
	for (const view of fixture.views) view.thread.status = "uncertain";
	const writes = fixture.writes.length;
	await page.goto(`/repos/${projectId}/agents`);
	await expect(page.getByRole("button", { name: "Open chat Chat 1", exact: true })).toHaveAttribute(
		"aria-current",
		"true",
	);
	await expect(page.getByText("Recovered history", { exact: true })).toBeVisible();
	await expect(page.getByText("uncertain", { exact: true })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Resume and load history", exact: true })).toHaveCount(0);
	expect(fixture.writes.slice(writes)).toEqual([`/api/agents/${fixture.views[0]!.thread.id}/resume`]);
	await page.getByRole("button", { name: "Open chat Chat 2", exact: true }).click();
	await expect(page.getByRole("button", { name: "Open chat Chat 2", exact: true })).toHaveAttribute(
		"aria-current",
		"true",
	);
	await expect(
		page.getByRole("region", { name: "Chat conversation" }).getByText("Recovered history", { exact: true }),
	).toBeVisible();
	expect(fixture.writes.slice(writes)).toEqual(fixture.views.map((view) => `/api/agents/${view.thread.id}/resume`));
	await page.reload();
	await expect(page.getByText("Recovered history", { exact: true })).toBeVisible();
	expect(fixture.writes.slice(writes)).toHaveLength(3);
});

test("history loading blocks sending and coalesces refreshes; failures allow an explicit retry", async ({ page }) => {
	const fixture = await setup(page);
	await fixture.create();
	await page.getByLabel("Message", { exact: true }).fill("Keep this draft");
	const view = fixture.views[0]!;
	let release = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`**/api/agents/${view.thread.id}/resume`, async (route) => {
		await held;
		await route.fallback();
	});
	view.thread.status = "uncertain";
	await fixture.event();
	await expect(page.getByText("Loading history…", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeDisabled();
	await fixture.event("open");
	await fixture.event();
	fixture.fail(true);
	release();
	await expect(page.getByRole("alert")).toContainText("Could not load chat history");
	const writes = fixture.writes.length;
	const reads = fixture.reads();
	await fixture.event("open");
	await expect.poll(fixture.reads).toBeGreaterThan(reads);
	expect(fixture.writes).toHaveLength(writes);
	await expect(page.getByText("uncertain", { exact: true })).toHaveCount(0);
	fixture.fail(false);
	await page.getByRole("button", { name: "Retry loading history", exact: true }).click();
	await expect(page.getByText("Recovered history", { exact: true })).toBeVisible();
	await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep this draft");
	await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
	expect(fixture.writes.filter((path) => path.endsWith("/resume"))).toHaveLength(2);
});

test("one-time command and file approvals, clarification and truncation are visible", async ({ page }) => {
	const fixture = await setup(page);
	await fixture.create();
	const view = fixture.views[0]!;
	view.thread.status = "waiting";
	view.truncated = true;
	view.requests = [{ id: "approval-1", kind: "command", description: "Run pnpm test", questions: [] }];
	await fixture.event();
	await expect(page.getByText("Some history or output was omitted.", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Allow once", exact: true }).click();
	await expect(page.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
	view.requests = [{ id: "approval-2", kind: "file", description: "Edit README.md", questions: [] }];
	view.thread.status = "waiting";
	await fixture.event();
	await page.getByRole("button", { name: "Decline", exact: true }).click();
	view.requests = [
		{
			id: "input",
			kind: "input",
			description: "Choose scope",
			questions: [{ id: "scope", question: "Which scope?", secret: false, options: ["Small", "Large"] }],
		},
	];
	view.thread.status = "waiting";
	await fixture.event();
	await page.getByRole("button", { name: "Small", exact: true }).click();
	fixture.fail(true);
	await page.getByRole("button", { name: "Submit answers", exact: true }).click();
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(page.getByLabel("Which scope?", { exact: true })).toHaveValue("Small");
	fixture.fail(false);
	await page.getByRole("button", { name: "Submit answers", exact: true }).click();
	await expect(page.getByRole("button", { name: "Submit answers", exact: true })).toHaveCount(0);
	expect(fixture.writes.filter((path) => path.endsWith("/replies"))).toHaveLength(4);
	expect(fixture.replies).toEqual([
		{ requestId: "approval-1", decision: "accept" },
		{ requestId: "approval-2", decision: "decline" },
		{ requestId: "input", answers: { scope: "Small" } },
	]);
});

for (const width of [1280, 448]) {
	test(`chat follows activity and exposes an accessible paused control at ${width}px`, async ({ page }) => {
		await page.setViewportSize({ width, height: 900 });
		const initialItems: AgentView["items"] = Array.from({ length: 40 }, (_, i) => ({
			id: `message-${i}`,
			role: "assistant",
			text: `Message ${i}\n${"Output ".repeat(40)}`,
		}));
		initialItems.unshift({
			id: "tool",
			role: "activity",
			title: "Inspect files",
			text: "Tool output\n".repeat(80),
			status: "completed",
		});
		const fixture = await setup(page, initialItems);
		await fixture.create();
		const view = fixture.views[0]!;
		const history = page.getByLabel("Conversation history", { exact: true });
		const arrow = page.getByRole("button", { name: "Scroll to latest", exact: true });
		const bottom = () => history.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
		await expect(history.locator("article")).toHaveCount(40);
		await expect.poll(bottom).toBeLessThan(2);
		view.items.push({ id: "stream", role: "assistant", text: "Streaming" });
		await fixture.event();
		await expect(page.getByText("Streaming", { exact: true })).toBeInViewport();
		view.items.at(-1)!.text += "\nMore output".repeat(50);
		await fixture.event();
		await expect(history).toContainText("More output");
		await expect.poll(bottom).toBeLessThan(2);
		await page.setViewportSize({ width, height: 650 });
		await history.evaluate(
			() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
		);
		await expect.poll(bottom).toBeLessThan(2);
		await history.evaluate((el) => {
			el.scrollTop = 100;
		});
		await expect(arrow).toBeVisible();
		await expect(arrow).not.toHaveClass(/agent-scroll-unseen/);
		await history.locator(".agent-tool-group > summary").evaluate((el: HTMLElement) => el.click());
		await expect(history.locator(".agent-tool-group")).toHaveAttribute("open", "");
		await expect(arrow).not.toHaveClass(/agent-scroll-unseen/);
		await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(100);
		const reads = fixture.reads();
		view.thread.status = "running";
		await fixture.event();
		await expect.poll(fixture.reads).toBeGreaterThan(reads);
		await expect(page.locator(".agent-chat-heading")).toContainText("running");
		await expect(arrow).not.toHaveClass(/agent-scroll-unseen/);
		await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(100);
		view.items.at(-1)!.text += "\nUnseen stream";
		await fixture.event();
		await expect(arrow).toHaveClass(/agent-scroll-unseen/);
		await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(100);
		await expect(arrow).toHaveCSS("animation-name", "agent-latest-pulse");
		await page.emulateMedia({ reducedMotion: "reduce" });
		await expect(arrow).toHaveCSS("animation-name", "none");
		await arrow.focus();
		await expect(arrow).toBeFocused();
		await arrow.press("Enter");
		await expect(arrow).toHaveCount(0);
		await expect.poll(bottom).toBeLessThan(2);
		await history.evaluate((el) => {
			el.scrollTop = 100;
		});
		await expect(arrow).toBeVisible();
		view.items.push({ id: "new", role: "user", text: "New message while paused" });
		await fixture.event();
		await expect(arrow).toHaveClass(/agent-scroll-unseen/);
		await history.evaluate((el) => {
			el.scrollTop = el.scrollHeight;
		});
		await expect(arrow).toHaveCount(0);
		view.items.at(-1)!.text += "\nFollowing again".repeat(40);
		await fixture.event();
		await expect(history).toContainText("Following again");
		await expect.poll(bottom).toBeLessThan(2);
		await history.evaluate((el) => {
			el.scrollTop = 100;
		});
		await expect(arrow).toBeVisible();
		await expect(arrow).not.toHaveClass(/agent-scroll-unseen/);
		await arrow.click();
		await expect(arrow).toHaveCount(0);
		await expect.poll(bottom).toBeLessThan(2);
	});
}

for (const size of [
	{ width: 1280, height: 900 },
	{ width: 448, height: 960 },
	{ width: 820, height: 820 },
]) {
	test(`chat scroll regions fill the visible viewport at ${size.width}px, including keyboard resize`, async ({
		page,
	}) => {
		await page.setViewportSize(size);
		const fixture = await setup(page);
		await fixture.create();
		const first = fixture.views[0]!;
		for (let i = 1; i < 40; i++)
			fixture.views.push({
				...first,
				thread: {
					...first.thread,
					id: `123e4567-e89b-42d3-a456-${String(426614174001 + i)}`,
					title: `Chat ${i + 1}`,
				},
			});
		first.items = Array.from({ length: 50 }, (_, i) => ({
			id: `message-${i}`,
			role: "assistant",
			text: `Message ${i}\n${"Long output ".repeat(30)}`,
		}));
		await page.getByRole("tab", { name: "Code", exact: true }).click();
		await page.getByRole("tab", { name: "Agents", exact: true }).click();
		await fixture.event();
		await expect(page.locator('.agent-sidebar button[aria-label="Open chat Chat 40"]')).toHaveCount(1);
		const check = async (height: number) => {
			await expect
				.poll(() => page.locator(".agent-panel").evaluate((el) => el.getBoundingClientRect().bottom))
				.toBeLessThanOrEqual(height);
			const panel = (await page.locator(".agent-panel").boundingBox())!;
			expect(panel.y + panel.height).toBeGreaterThan(height - 40);
			await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeInViewport();
			const send = (await page.getByRole("button", { name: "Send message", exact: true }).boundingBox())!;
			expect(send.y + send.height).toBeLessThanOrEqual(height);
			for (const selector of [".agent-sidebar nav", ".agent-messages"]) {
				if (size.width <= 700 && selector.includes("nav"))
					await page.getByRole("button", { name: "Back to chats", exact: true }).click();
				const region = page.locator(selector);
				await expect(region).toBeVisible();
				await expect
					.poll(() => region.evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight > 0))
					.toBe(true);
				await region.evaluate((el) => {
					el.scrollTop = el.scrollHeight;
				});
				await expect(region.locator(selector.includes("nav") ? "button" : "article").last()).toBeInViewport();
				const rect = (await region.boundingBox())!;
				expect(rect.height).toBeGreaterThanOrEqual(40);
				expect(rect.y + rect.height).toBeLessThanOrEqual(height);
				if (size.width <= 700 && selector.includes("nav"))
					await page.getByRole("button", { name: "Open chat Chat 1", exact: true }).click();
			}
			expect(
				await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && scrollY === 0),
			).toBe(true);
		};
		await check(size.height);
		if (size.width < 1000) {
			await page.getByLabel("Message", { exact: true }).focus();
			await page.evaluate(() => {
				Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: 480 });
				window.visualViewport!.dispatchEvent(new Event("resize"));
			});
			await check(480);
			await page.screenshot({ path: `../../artifacts/forge-browser/agents-keyboard-${size.width}.png` });
			await page.evaluate(() => {
				Reflect.deleteProperty(window.visualViewport!, "height");
				window.visualViewport!.dispatchEvent(new Event("resize"));
			});
			await check(size.height);
		}
	});
}

test("mobile URLs select one pane, restore focus and support history, reload and resizing", async ({ page }) => {
	await page.setViewportSize({ width: 700, height: 844 });
	const fixture = await setup(page);
	await fixture.create();
	const url = page.url();
	const back = page.getByRole("button", { name: "Back to chats", exact: true });
	const chat = page.getByRole("button", { name: "Open chat Chat 1", exact: true });
	const main = page.locator(".agent-main");
	const sidebar = page.getByLabel("Chats", { exact: true });
	await expect(main).toBeFocused();
	await expect(sidebar).toBeHidden();
	await page.locator(".agent-sidebar > button").evaluate((el: HTMLButtonElement) => el.focus());
	await expect(main).toBeFocused();
	await back.click();
	await expect(chat).toBeFocused();
	await expect(main).toBeHidden();
	await page.locator(".agent-main textarea").evaluate((el: HTMLTextAreaElement) => el.focus());
	await expect(chat).toBeFocused();
	await page.screenshot({ path: "../../artifacts/forge-browser/agents-mobile-list.png" });
	await page.getByRole("tab", { name: "Code", exact: true }).click();
	await page.getByRole("tab", { name: "Agents", exact: true }).click();
	await expect(main).toBeHidden();
	await page.reload();
	await expect(chat).toBeVisible();
	await expect(main).toBeHidden();
	await chat.click();
	await expect(main).toBeFocused();
	await expect(sidebar).toBeHidden();
	await page.goBack();
	await expect(chat).toBeFocused();
	await page.goForward();
	await expect(main).toBeFocused();
	await page.reload();
	await expect(page).toHaveURL(url);
	await expect(back).toBeVisible();
	await expect(sidebar).toBeHidden();
	await page.setViewportSize({ width: 701, height: 844 });
	await expect(sidebar).toBeVisible();
	await expect(main).toBeVisible();
	await expect(back).toBeHidden();
	await expect(page).toHaveURL(url);
	await page.setViewportSize({ width: 700, height: 844 });
	await expect(sidebar).toBeHidden();
	await expect(page).toHaveURL(url);
	await back.click();
	await page.setViewportSize({ width: 701, height: 844 });
	await expect(page).toHaveURL(url);
	await expect(sidebar).toBeVisible();
	await page.setViewportSize({ width: 390, height: 844 });
	await back.click();
	fixture.fail(true);
	await page.getByRole("button", { name: "Create chat", exact: true }).click();
	await expect(page.getByRole("alert")).toBeVisible();
	await expect(main).toBeHidden();
	fixture.fail(false);
	await fixture.create();
	await expect(sidebar).toBeHidden();
	await page.goto(`/repos/${projectId}/agents/123e4567-e89b-42d3-a456-426614174099`);
	await expect(page.getByRole("heading", { name: "Chat unavailable", exact: true })).toBeVisible();
	await expect(sidebar).toBeHidden();
	await back.click();
	await expect(page.getByRole("button", { name: "Create chat", exact: true })).toBeFocused();
	await expect(main).toBeHidden();
});

test("mobile list and section navigation retain drafts, answers, paused history and running activity", async ({
	page,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const fixture = await setup(
		page,
		Array.from({ length: 40 }, (_, i) => ({
			id: `message-${i}`,
			role: "assistant",
			text: `Message ${i}\n${"Output ".repeat(40)}`,
		})),
	);
	await fixture.create();
	const view = fixture.views[0]!;
	view.thread.status = "waiting";
	view.thread.turnId = "turn-1";
	view.requests = [
		{
			id: "question",
			kind: "input",
			description: "Choose an approach",
			questions: [{ id: "approach", question: "Which approach?", options: [], secret: false }],
		},
	];
	await fixture.event();
	await page.getByLabel("Which approach?", { exact: true }).fill("Keep my answer");
	await page.getByLabel("Message", { exact: true }).fill("Keep my draft");
	const history = page.getByLabel("Conversation history", { exact: true });
	await history.evaluate((el) => {
		el.scrollTop = 100;
	});
	await expect(page.getByRole("button", { name: "Scroll to latest", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Back to chats", exact: true }).click();
	const reads = fixture.reads();
	view.items.push({ id: "background", role: "assistant", text: "Activity while reading the list" });
	await fixture.event();
	await expect.poll(fixture.reads).toBeGreaterThan(reads);
	await page.getByRole("tab", { name: "Code", exact: true }).click();
	await page.getByRole("tab", { name: "Agents", exact: true }).click();
	await expect(page.locator(".agent-main")).toBeHidden();
	await page.getByRole("button", { name: "Open chat Chat 1", exact: true }).click();
	await expect(page.getByLabel("Message", { exact: true })).toHaveValue("Keep my draft");
	await expect(page.getByLabel("Which approach?", { exact: true })).toHaveValue("Keep my answer");
	await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(100);
	await expect(page.getByRole("button", { name: "Scroll to latest", exact: true })).toHaveClass(
		/agent-scroll-unseen/,
	);
	await expect(history).toContainText("Activity while reading the list");
	await page.getByRole("tab", { name: "Code", exact: true }).click();
	await page.getByRole("tab", { name: "Agents", exact: true }).click();
	await expect(page.locator(".agent-main")).toBeFocused();
	await expect.poll(() => history.evaluate((el) => el.scrollTop)).toBe(100);
	view.requests = [];
	view.thread.status = "running";
	await fixture.event();
	await expect(page.getByRole("button", { name: "Interrupt", exact: true })).toBeEnabled();
	await page.getByRole("button", { name: "Back to chats", exact: true }).click();
	view.items.push({ id: "running", role: "assistant", text: "Still working" });
	await fixture.event();
	await page.getByRole("button", { name: "Open chat Chat 1", exact: true }).click();
	await expect(history).toContainText("Still working");
	expect(fixture.writes).toHaveLength(1);
});

test("mobile loading chat offers explicit list navigation", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await setup(page);
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(`**/api/projects/${projectId}/agents`, async (route) => {
		await pending;
		await route.fulfill({ json: [] });
	});
	await page.goto(`/repos/${projectId}/agents/123e4567-e89b-42d3-a456-426614174099`, {
		waitUntil: "domcontentloaded",
	});
	await expect(page.getByRole("heading", { name: "Loading chat…", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Back to chats", exact: true }).click();
	await expect(page.locator(".agent-main")).toBeHidden();
	release();
	await expect(page.getByRole("button", { name: "Create chat", exact: true })).toBeFocused();
});

test("mobile chat keeps composer and long tool output within the viewport", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const fixture = await setup(page);
	await fixture.create();
	fixture.views[0]!.items = [
		{ id: "long", role: "activity", text: "command-output-".repeat(80) },
		{ id: "reply", role: "assistant", text: "Ready for your next message." },
	];
	await fixture.event();
	await expect(page.getByText("Ready for your next message.", { exact: true })).toBeVisible();
	await page.getByLabel("Message", { exact: true }).fill("A mobile draft");
	await page.screenshot({ path: "../../artifacts/forge-browser/agents-mobile.png", fullPage: true });
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
