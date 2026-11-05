import { mkdtemp, readFile as nodeReadFile, readdir, rm, stat, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { atomicWriteFile, createFileIfMissing, readFile, readFileBytes, writeFile } from "./file.ts";

const directories: string[] = [];
const directory = async () => {
	const path = await mkdtemp(join(tmpdir(), "paas-file-"));
	directories.push(path);
	return path;
};
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("only missing files are absent; other read failures propagate", async () => {
	const root = await directory();
	expect(await readFile(join(root, "missing"))).toBeUndefined();
	await expect(readFile(root)).rejects.toMatchObject({ code: "EISDIR" });
});

test.skipIf(process.getuid?.() === 0)("permission failures remain errors", async () => {
	const path = join(await directory(), "private");
	await writeFile(path, "secret");
	await chmod(path, 0);
	await expect(readFile(path)).rejects.toMatchObject({ code: "EACCES" });
});

test("binary reads preserve bytes", async () => {
	const path = join(await directory(), "asset");
	await writeFile(path, new Uint8Array([0, 255, 128]));
	expect(await readFileBytes(path)).toEqual(Buffer.from([0, 255, 128]));
});

test("atomic concurrent writes leave a complete restricted file and no temporary files", async () => {
	const root = await directory();
	const path = join(root, "state.yaml");
	const values = ["first".repeat(1000), "second".repeat(1000)];
	await Promise.all(values.map((value) => atomicWriteFile(path, value, { mode: 0o600 })));
	expect(values).toContain(await nodeReadFile(path, "utf8"));
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect(await readdir(root)).toEqual(["state.yaml"]);
});

test("atomic failures clean temporary files and preserve the destination", async () => {
	const root = await directory();
	const path = join(root, "existing-directory");
	await mkdir(path);
	await expect(atomicWriteFile(path, "replacement")).rejects.toThrow();
	expect((await stat(path)).isDirectory()).toBe(true);
	expect(await readdir(root)).toEqual(["existing-directory"]);
});

test("exclusive creation has one winner and preserves existing content", async () => {
	const path = join(await directory(), "seed");
	const results = await Promise.all([createFileIfMissing(path, "one"), createFileIfMissing(path, "two")]);
	expect(results.filter(Boolean)).toHaveLength(1);
	expect(await nodeReadFile(path, "utf8")).toBe(results[0] ? "one" : "two");
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	await expect(createFileIfMissing(join(path, "invalid"), "value")).rejects.toMatchObject({ code: "ENOTDIR" });
});
