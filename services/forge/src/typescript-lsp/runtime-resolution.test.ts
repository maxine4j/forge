import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { afterEach, expect, test } from "vitest";

import { RuntimeResolver } from "./runtime-resolution.ts";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await files.rm(root, { recursive: true, force: true });
});
const fixture = async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-lsp-resolution-"));
	roots.push(root);
	await files.writeFile(join(root, "package.json"), "{}");
	await files.writeFile(join(root, "index.ts"), "export const value = 1;");
	return { root, resolver: new RuntimeResolver(root, files) };
};
const install = async (directory: string, version: string) => {
	const root = join(directory, "node_modules/typescript");
	await files.mkdir(join(root, "bin"), { recursive: true });
	await files.mkdir(join(root, "lib"), { recursive: true });
	await files.writeFile(join(root, "package.json"), JSON.stringify({ version, bin: { tsc: "bin/tsc" } }));
	await files.writeFile(join(root, version.startsWith("7") ? "bin/tsc" : "lib/tsserver.js"), "");
	return root;
};
test("resolves native and exact tsserver installations across package boundaries", async () => {
	const { root, resolver } = await fixture();
	await install(root, "7.0.2");
	const pkg = join(root, "packages/legacy");
	await files.mkdir(pkg, { recursive: true });
	await files.writeFile(join(pkg, "package.json"), "{}");
	await files.writeFile(join(pkg, "index.ts"), "");
	await install(pkg, "5.9.3");
	expect(await resolver.resolve(await resolver.file("index.ts"))).toMatchObject({
		kind: "native",
		version: "7.0.2",
		packagePath: root,
	});
	expect(await resolver.resolve(await resolver.file("packages/legacy/index.ts"))).toMatchObject({
		kind: "tsserver",
		version: "5.9.3",
		packagePath: pkg,
		entry: join(pkg, "node_modules/typescript/lib/tsserver.js"),
	});
});
test("allows package-store symlinks but rejects source symlinks, traversal and absolute paths", async () => {
	const { root, resolver } = await fixture();
	const other = await fixture();
	const store = await install(other.root, "7.0.2");
	await files.mkdir(join(root, "node_modules"));
	await files.symlink(store, join(root, "node_modules/typescript"));
	expect((await resolver.resolve(await resolver.file("index.ts"))).installation).toBe(store);
	await files.symlink(join(other.root, "index.ts"), join(root, "external.ts"));
	for (const path of ["../index.ts", "/tmp/index.ts", "external.ts", "a/../../index.ts", "a\\b.ts"])
		await expect(resolver.file(path)).rejects.toMatchObject({ code: "invalid_input" });
});
test("missing, unsupported and broken installations never fall through to Forge's compiler", async () => {
	const { root, resolver } = await fixture();
	await expect(resolver.resolve(join(root, "index.ts"))).rejects.toThrow("TypeScript is missing for package .");
	await install(root, "3.9.0");
	await expect(resolver.resolve(join(root, "index.ts"))).rejects.toThrow("Broken or unsupported");
	await install(root, "7.0.2");
	const pkg = join(root, "packages/broken");
	await files.mkdir(pkg, { recursive: true });
	await files.writeFile(join(pkg, "package.json"), "{}");
	await files.writeFile(join(pkg, "index.ts"), "");
	const broken = await install(pkg, "6.0.3");
	await files.rm(join(broken, "lib/tsserver.js"));
	await expect(resolver.resolve(join(pkg, "index.ts"))).rejects.toThrow("packages/broken/node_modules/typescript");
});
