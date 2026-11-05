import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, mkdir, writeFile, symlink, rm } from "@forge/backend-infrastructure/file";
import * as files from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import { StaticAssets } from "./static-assets.ts";

test("serves only owned built files, falls back for navigation, and never masks APIs or missing assets", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-assets-"));
	try {
		await mkdir(join(root, "assets"));
		await writeFile(join(root, "index.html"), "<main>Forge</main>");
		await writeFile(join(root, "assets/app-12345678.js"), "export {};");
		await writeFile(join(root, "assets/plain.js"), "export {};");
		await writeFile(join(root, "private.txt"), "secret");
		await symlink(join(root, "private.txt"), join(root, "assets/leak.js"));
		const assets = new StaticAssets(root, files);
		expect(await assets.read("/projects/one")).toMatchObject({ type: "text/html", immutable: false });
		expect(await assets.read("/assets/app-12345678.js")).toMatchObject({
			type: "text/javascript",
			immutable: true,
		});
		expect(await assets.read("/assets/plain.js")).toMatchObject({ immutable: false });
		for (const path of [
			"/api",
			"/api/missing",
			"/assets/missing.js",
			"/assets/leak.js",
			"/../private.txt",
			"/%2e%2e/private.txt",
			"/assets%2fapp-123.js",
			"/private.txt",
			"/bad%",
			"/a\\b",
		])
			expect(await assets.read(path), path).toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
