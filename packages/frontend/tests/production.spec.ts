import { once } from "node:events";
import { createServer } from "node:http";
import { resolve } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { expect, test } from "@playwright/test";
import { build } from "vite";

import { AccessService } from "../../../src/auth/access-service.ts";
import { HttpApplication } from "../../../src/http/http-application.ts";
import { StaticAssets } from "../../../src/http/static-assets.ts";
import { ProjectRouter } from "../../../src/projects/project-router.ts";

test("integrated production bundle styles editor/terminal on desktop/mobile and blocks inline scripts", async ({
	page,
}) => {
	const directory = resolve("../../artifacts/forge-production-build");
	await build({ build: { outDir: directory, emptyOutDir: true } });
	const projects = {
		list: async () => [],
		create: async () => {
			throw new Error("Unused");
		},
		get: async () => {
			throw new Error("Unused");
		},
		retry: async () => {
			throw new Error("Unused");
		},
		recover: async () => {},
	};
	const app = new HttpApplication(
		new ProjectRouter(projects),
		new AccessService({ owner: "owner", origin: "https://forge.example.com" }),
	).create([], new StaticAssets(directory, files));
	const server = createServer(app.callback());
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No port");
		const projectId = "123e4567-e89b-42d3-a456-426614174000";
		const id = "123e4567-e89b-42d3-a456-426614174001";
		const terminalId = "123e4567-e89b-42d3-a456-426614174002";
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
		const session = { id: terminalId, workspaceId: id, status: "running", cols: 80, rows: 24, createdAt };
		const empty = { files: [], patch: "", truncated: false };
		await page.route(
			(url) => url.pathname.startsWith("/api/"),
			(route) => {
				const path = new URL(route.request().url()).pathname;
				if (path === "/api/projects")
					return route.fulfill({
						json: [{ id: projectId, name: "Production project", status: "ready", createdAt }],
					});
				if (path.endsWith("/accounts"))
					return route.fulfill({
						json: {
							codex: { connection: "available", login: { state: "idle" } },
							github: { connection: "available", login: { state: "idle" } },
						},
					});
				if (path.endsWith("/branches")) return route.fulfill({ json: [{ name: "main", sha: head }] });
				if (path.endsWith("/workspaces")) return route.fulfill({ json: [workspace] });
				if (path.endsWith("/pull-requests")) return route.fulfill({ json: [] });
				if (path.endsWith("/tickets"))
					return route.fulfill({
						json: [
							{
								id: "FORGE-1",
								repositoryIds: [projectId],
								title: "Production ticket",
								description: "Scope",
								status: "backlog",
								createdAt,
							},
						],
					});
				if (path.endsWith("/tree"))
					return route.fulfill({
						json: {
							path: "",
							head,
							entries: [{ path: "file.ts", name: "file.ts", kind: "file" }],
							truncated: false,
						},
					});
				if (path.endsWith("/file"))
					return route.fulfill({
						json: { path: "file.ts", content: "export const highlighted = 42;" },
					});
				if (path.endsWith("/diff"))
					return route.fulfill({
						json: {
							comparison: "merge-base(main, workspace)..workspace",
							baseSha: head,
							head,
							branch: empty,
							staged: empty,
							unstaged: empty,
							untracked: empty,
						},
					});
				if (path.endsWith("/terminal"))
					return route.fulfill({ json: route.request().method() === "POST" ? session : {} });
				return route.fulfill({ status: 404, json: {} });
			},
		);
		const sizes: { cols: number; rows: number }[] = [];
		await page.routeWebSocket(`**/api/terminals/${terminalId}/socket?after=*`, (socket) => {
			socket.onMessage((message) => {
				const input = JSON.parse(String(message));
				if (input.type === "resize") sizes.push(input);
			});
			socket.send(JSON.stringify({ type: "output", sequence: 1, data: "Production terminal output\r\n" }));
			socket.send(JSON.stringify({ type: "status", session }));
		});
		await page.setExtraHTTPHeaders({ "x-webauth-user": "owner" });
		await page.addInitScript(() => {
			Object.assign(window, { cspViolations: [], inlineScriptRan: false });
			document.addEventListener("securitypolicyviolation", (event) => {
				(window as unknown as { cspViolations: string[] }).cspViolations.push(event.effectiveDirective);
			});
		});
		const response = await page.goto(
			`http://127.0.0.1:${address.port}/repos/${projectId}/code?branch=main&file=file.ts`,
		);
		expect(response?.headers()["cache-control"]).toBe("no-store");
		expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
		await expect(page.getByRole("textbox", { name: "File editor" })).toBeVisible();
		await page.reload();
		await expect(page.getByRole("textbox", { name: "File editor" })).toContainText(
			"export const highlighted = 42;",
		);
		const contrast = await page.locator(".cm-content span").evaluateAll((spans) => {
			const luminance = (color: string) => {
				const channels = color
					.match(/\d+/gu)!
					.slice(0, 3)
					.map((value) => {
						const channel = Number(value) / 255;
						return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
					});
				return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
			};
			const background = luminance(getComputedStyle(document.querySelector(".cm-editor")!).backgroundColor);
			return spans
				.filter((span) => span.textContent?.trim())
				.map((span) => {
					const foreground = luminance(getComputedStyle(span).color);
					return (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
				});
		});
		expect(contrast.length).toBeGreaterThan(0);
		for (const ratio of contrast) expect(ratio).toBeGreaterThanOrEqual(4.5);
		await page.screenshot({ path: "../../artifacts/forge/files-desktop.png", fullPage: true });
		await page.getByRole("link", { name: "Tasks", exact: true }).click();
		await page.getByRole("button", { name: "Drag FORGE-1", exact: true }).hover();
		await page.mouse.down();
		const target = (await page.getByRole("region", { name: "Ready for development", exact: true }).boundingBox())!;
		await page.mouse.move(target.x + 80, target.y + 120);
		await expect(page.locator(".ticket-drop-placeholder")).toBeVisible();
		await expect(page.locator(".ticket-drag-preview")).toBeVisible();
		await page.screenshot({ path: "../../artifacts/forge/tasks-production-drag.png" });
		await page.keyboard.press("Escape");
		await page.mouse.up();
		await page.goBack();
		await page.getByRole("tab", { name: "Terminals", exact: true }).click();
		await expect(page.getByRole("region", { name: "Terminal", exact: true }).getByRole("button")).toHaveCount(0);
		await expect(page.locator(".xterm-rows")).toContainText("Production terminal output");
		await expect.poll(() => sizes.length).toBeGreaterThan(0);
		await page.screenshot({ path: "../../artifacts/forge/production-desktop.png", fullPage: true });
		await page.setViewportSize({ width: 390, height: 844 });
		await expect.poll(() => sizes.at(-1)?.cols).toBeLessThan(sizes[0]!.cols);
		expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
		await page.screenshot({ path: "../../artifacts/forge/production-mobile.png", fullPage: true });
		expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
		await page.evaluate(() => {
			const script = document.createElement("script");
			script.textContent = "window.inlineScriptRan = true";
			document.body.append(script);
		});
		await expect
			.poll(() => page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations))
			.toContain("script-src-elem");
		expect(await page.evaluate(() => (window as unknown as { inlineScriptRan: boolean }).inlineScriptRan)).toBe(
			false,
		);
		expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([
			"script-src-elem",
		]);
		await page.getByRole("tab", { name: "Code", exact: true }).click();
		await page.getByRole("tab", { name: "file.ts", exact: true }).click();
		await expect(page.getByRole("textbox", { name: "File editor" })).toBeVisible();
		expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe("dark");
		const colors = await page
			.locator(".cm-content span")
			.evaluateAll((spans) => spans.map((span) => getComputedStyle(span).color));
		expect(new Set(colors).size).toBeGreaterThan(1);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});
