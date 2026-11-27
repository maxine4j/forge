import { defaultForgeSettings } from "@forge/contracts/settings";
import { expect, test } from "@playwright/test";

test.use({ hasTouch: true });

for (const device of ["phone", "tablet"] as const) {
	test(`${device} terminal keyboard toolbar input, viewport and cleanup`, async ({ page }) => {
		const width = device === "phone" ? 390 : 820;
		await page.setViewportSize({ width, height: 900 });
		await page.addInitScript((visual) => {
			if (!visual) {
				Object.defineProperty(window, "visualViewport", { value: undefined });
				return;
			}
			const viewport = Object.assign(new EventTarget(), {
				height: 900,
				width: 390,
				offsetTop: 0,
				offsetLeft: 0,
				scale: 1,
			});
			Object.defineProperty(window, "visualViewport", { value: viewport });
		}, device === "phone");
		const projectId = "123e4567-e89b-42d3-a456-426614174000";
		const id = "123e4567-e89b-42d3-a456-426614174001";
		const createdAt = "2026-11-02T00:00:00.000Z";
		const session = { id, workspaceId: id, status: "running", cols: 80, rows: 24, createdAt };
		const inputs: string[] = [];
		const rows: number[] = [];
		let output = (_data: string) => {};
		let disconnect = () => {};
		const idle = { connection: "available", login: { state: "idle" } };
		await page.route("**/api/accounts", (route) => route.fulfill({ json: { codex: idle, github: idle } }));
		await page.route("**/api/settings", (route) => route.fulfill({ json: defaultForgeSettings }));
		await page.route("**/api/settings/model-options", (route) =>
			route.fulfill({ json: { models: [], skills: [] } }),
		);
		await page.route("**/api/projects/*/repository/branches", (route) => route.fulfill({ json: [] }));
		await page.route("**/api/projects/*/repository/tree?*", (route) =>
			route.fulfill({ json: { path: "", head: "a".repeat(40), entries: [], truncated: false } }),
		);
		await page.route("**/api/projects", (route) =>
			route.fulfill({ json: [{ id: projectId, name: "Project", status: "ready", createdAt }] }),
		);
		await page.route(`**/api/projects/${projectId}/workspaces`, (route) =>
			route.fulfill({
				json: [
					{
						id,
						projectId,
						name: "Manual",
						branch: `forge/workspace/${id}`,
						head: "a".repeat(40),
						baseSha: "a".repeat(40),
						status: "ready",
						createdAt,
					},
				],
			}),
		);
		await page.route(`**/api/workspaces/${id}/terminal`, (route) => route.fulfill({ json: { session } }));
		await page.routeWebSocket("**/api/terminals/*/socket?after=*", (socket) => {
			let sequence = 0;
			output = (data) => socket.send(JSON.stringify({ type: "output", sequence: ++sequence, data }));
			disconnect = () => {
				void socket.close();
			};
			socket.onMessage((message) => {
				const frame = JSON.parse(String(message));
				if (frame.type === "input") inputs.push(frame.data);
				if (frame.type === "resize") rows.push(frame.rows);
			});
		});
		await page.goto(`/repos/${projectId}/terminals`);
		await expect(page.getByText("Connected", { exact: true })).toBeVisible();
		const toolbar = page.locator(".terminal-keyboard-toolbar");
		const textarea = page.locator(".xterm-helper-textarea");
		await expect(toolbar).toHaveCount(0);
		await expect.poll(() => rows.length).toBeGreaterThan(0);
		const closedRows = rows.at(-1)!;
		await textarea.focus();
		if (device === "phone") {
			await page.evaluate(() => {
				Object.assign(window.visualViewport!, { height: 500, offsetTop: 30, offsetLeft: 2 });
				window.visualViewport!.dispatchEvent(new Event("resize"));
			});
		} else await page.setViewportSize({ width, height: 500 });
		await expect(toolbar).toBeVisible();
		await expect.poll(() => rows.at(-1)!).toBeLessThan(closedRows);
		const box = await toolbar.boundingBox();
		expect(box?.y).toBe(device === "phone" ? 478 : 448);
		expect(box?.x).toBe(device === "phone" ? 2 : 0);
		expect(box?.width).toBe(width);
		const terminalBox = await page.locator(".terminal-view").boundingBox();
		expect(terminalBox!.y + terminalBox!.height).toBeLessThanOrEqual(box!.y);
		await page.screenshot({ path: `../../artifacts/forge/terminal-keyboard-${device}.png` });
		await toolbar.getByRole("button", { name: "Control R", exact: true }).tap();
		await toolbar.getByRole("button", { name: "Control C", exact: true }).tap();
		await toolbar.getByRole("button", { name: "Escape", exact: true }).tap();
		await toolbar.getByRole("button", { name: "Tab", exact: true }).tap();
		const ctrl = toolbar.getByRole("button", { name: "Control modifier" });
		await ctrl.tap();
		await expect(ctrl).toHaveAttribute("aria-pressed", "true");
		await expect(textarea).toBeFocused();
		await page.keyboard.type("d");
		await expect(ctrl).toHaveAttribute("aria-pressed", "false");
		await page.keyboard.type("x");
		await ctrl.tap();
		await textarea.evaluate((element) => {
			const clipboardData = new DataTransfer();
			clipboardData.setData("text/plain", "pasted text");
			element.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
		});
		await expect(ctrl).toHaveAttribute("aria-pressed", "false");
		await ctrl.tap();
		await ctrl.tap();
		await page.keyboard.type("z");
		for (const [mode, prefix] of [
			[false, "\x1b["],
			[true, "\x1bO"],
		] as const) {
			const marker = mode ? "application cursor" : "normal cursor";
			output(`${mode ? "\x1b[?1h" : "\x1b[?1l"}${marker}\r\n`);
			await expect(page.locator(".xterm-rows")).toContainText(marker);
			for (const [name, suffix] of [
				["Left", "D"],
				["Up", "A"],
				["Down", "B"],
				["Right", "C"],
			]) {
				await toolbar.getByRole("button", { name: `${name} arrow` }).tap();
				await expect.poll(() => inputs.at(-1)).toBe(prefix + suffix);
				await expect(textarea).toBeFocused();
			}
		}
		expect(inputs.slice(0, 8)).toEqual(["\x12", "\x03", "\x1b", "\t", "\x04", "x", "pasted text", "z"]);
		await ctrl.tap();
		await toolbar.getByRole("button", { name: "Escape", exact: true }).tap();
		await expect(ctrl).toHaveAttribute("aria-pressed", "false");
		await expect.poll(() => inputs.at(-1)).toBe("\x1b");
		await ctrl.tap();
		await page.keyboard.insertText("é👋");
		await expect(ctrl).toHaveAttribute("aria-pressed", "false");
		await expect.poll(() => inputs.at(-1)).toBe("é👋");
		await ctrl.tap();
		await ctrl.focus();
		await expect(ctrl).toHaveAttribute("aria-pressed", "true");
		await textarea.focus();
		await expect(ctrl).toHaveAttribute("aria-pressed", "true");
		await page.getByRole("link", { name: "Config", exact: true }).focus();
		await expect(toolbar).toHaveCount(0);
		await textarea.focus();
		await expect(ctrl).toHaveAttribute("aria-pressed", "false");
		const beforeScrolling = inputs.length;
		if (device === "phone") {
			await toolbar.evaluate((element) => {
				element.scrollLeft = 0;
			});
			const client = await page.context().newCDPSession(page);
			await client.send("Input.dispatchTouchEvent", {
				type: "touchStart",
				touchPoints: [{ x: 300, y: box!.y + 22 }],
			});
			for (const x of [250, 200, 150, 100]) {
				await client.send("Input.dispatchTouchEvent", {
					type: "touchMove",
					touchPoints: [{ x, y: box!.y + 22 }],
				});
				await page.waitForTimeout(20);
			}
			await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
			await client.detach();
		}
		await expect(textarea).toBeFocused();
		expect(inputs).toHaveLength(beforeScrolling);
		if (device === "phone") expect(await toolbar.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
		disconnect();
		await expect(toolbar.getByRole("button").first()).toBeDisabled();
		const count = inputs.length;
		await page.keyboard.type("offline");
		await expect(page.getByText("Connected", { exact: true })).toBeVisible();
		expect(inputs).toHaveLength(count);
		await ctrl.tap();
		await page.getByRole("tab", { name: "Code", exact: true }).click();
		await expect(toolbar).toHaveCount(0);
		await page.getByRole("tab", { name: "Terminals", exact: true }).click();
		await expect(page.getByRole("region", { name: "Terminal", exact: true })).toBeVisible();
		await textarea.focus();
		await expect(textarea).toBeFocused();
		await expect(ctrl).toHaveAttribute("aria-pressed", "false");
		await page.getByRole("link", { name: "Config", exact: true }).click();
		await expect(toolbar).toHaveCount(0);
		await page.goBack();
		await expect(page.getByRole("region", { name: "Terminal", exact: true })).toBeVisible();
		await textarea.focus();
		if (device === "phone") {
			await ctrl.tap();
			await page.evaluate(() => {
				Object.assign(window.visualViewport!, { height: 250, scale: 2 });
				window.visualViewport!.dispatchEvent(new Event("resize"));
			});
			await expect(toolbar).toHaveCount(0);
			await page.evaluate(() => {
				Object.assign(window.visualViewport!, { height: 500, scale: 1 });
				window.visualViewport!.dispatchEvent(new Event("resize"));
			});
			await expect(ctrl).toHaveAttribute("aria-pressed", "false");
			await page.evaluate(() => {
				Object.assign(window.visualViewport!, { height: 390, width: 900 });
				window.dispatchEvent(new Event("orientationchange"));
			});
			await expect(toolbar).toHaveCount(0);
			await page.evaluate(() => {
				Object.assign(window.visualViewport!, { height: 270 });
				window.visualViewport!.dispatchEvent(new Event("resize"));
			});
			await expect(toolbar).toBeVisible();
			await page.evaluate(() => {
				Object.assign(window.visualViewport!, { height: 900, offsetTop: 0 });
				window.visualViewport!.dispatchEvent(new Event("resize"));
			});
		} else await page.setViewportSize({ width, height: 900 });
		await expect(toolbar).toHaveCount(0);
		await page.getByRole("link", { name: "Repos", exact: true }).click();
		await page.evaluate(() => window.dispatchEvent(new Event("resize")));
		await expect(toolbar).toHaveCount(0);
	});
}
