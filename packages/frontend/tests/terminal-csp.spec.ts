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

test("real xterm renders without violating the production HTTP CSP", async ({ page }) => {
	const directory = resolve("../../artifacts/forge-csp-build");
	await build({
		configFile: false,
		build: { outDir: directory, emptyOutDir: true, rollupOptions: { input: resolve("tests/terminal-csp.html") } },
	});
	const assets = new StaticAssets(directory, files);
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
	).create([], {
		read: async (path) => {
			if (path === "/")
				return {
					bytes: await files.readFileBytes(resolve(directory, "tests/terminal-csp.html")),
					type: "text/html",
					immutable: false,
				};
			return assets.read(path);
		},
	});
	const server = createServer(app.callback());
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No port");
		await page.setExtraHTTPHeaders({ "x-webauth-user": "owner" });
		await page.addInitScript(() => {
			Object.assign(window, { cspViolations: [] });
			document.addEventListener("securitypolicyviolation", (event) => {
				(window as unknown as { cspViolations: string[] }).cspViolations.push(
					`${event.effectiveDirective}: ${event.blockedURI}`,
				);
			});
		});
		const response = await page.goto(`http://127.0.0.1:${address.port}/`);
		expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
		await expect(page.locator(".xterm")).toBeVisible();
		await page.waitForTimeout(300);
		await page.screenshot({ path: "../../artifacts/forge/terminal-production-csp.png" });
		expect(await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations)).toEqual([]);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});
