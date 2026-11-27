import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { commitDetailSchema, commitPatchSchema } from "@forge/contracts";
import { afterEach, expect, test } from "vitest";

import { CommitReader } from "./commit-reader.ts";
import { GitTransport } from "./git-transport.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
	const root = await files.mkdtemp(join(tmpdir(), "forge-commit-"));
	cleanup.push(() => files.rm(root, { recursive: true, force: true }));
	const git = new GitTransport();
	cleanup.push(() => git.close());
	const args = ["-C", root, "-c", "user.name=Owner", "-c", "user.email=owner@example.test"];
	const run = (command: string[]) => git.run([...args, ...command]);
	await run(["init", "--initial-branch=main"]);
	const reader = new CommitReader(run, (command) => git.runBytes([...args, ...command]));
	const commit = async (message: string) => {
		await run(["add", "-A"]);
		await run(["commit", "--allow-empty", "-m", message]);
		return (await run(["rev-parse", "HEAD"])).trim();
	};
	return { root, run, reader, commit };
}

test("root, ordinary, merge and empty commits use the first parent or empty tree", async () => {
	const { root, run, reader, commit } = await setup();
	await files.writeFile(join(root, "hello.txt"), "hello\n");
	const first = await commit("Root\n\nMultiline body\nSecond line");
	const rootDetail = await reader.detail(first);
	expect(rootDetail).toMatchObject({ base: null, parents: [], additions: 1, deletions: 0, truncated: false });
	expect(rootDetail.message).toContain("Multiline body\nSecond line");
	expect(rootDetail.files[0]).toMatchObject({ path: "hello.txt", status: "A" });
	expect((await reader.patch(first, "hello.txt", false)).hunks[0]?.lines).toEqual([
		{ kind: "addition", text: "hello", new: 1 },
	]);
	await run(["switch", "-c", "topic"]);
	await files.writeFile(join(root, "topic.txt"), "topic\n");
	const topic = await commit("Topic");
	await run(["switch", "main"]);
	await files.writeFile(join(root, "main.txt"), "main\n");
	const main = await commit("Main");
	await run(["merge", "--no-ff", "topic", "-m", "Merge"]);
	const merge = (await run(["rev-parse", "HEAD"])).trim();
	expect(await reader.detail(merge)).toMatchObject({
		base: main,
		parents: [main, topic],
		files: [{ path: "topic.txt", status: "A" }],
	});
	const empty = await commit("Empty");
	expect(await reader.detail(empty)).toMatchObject({ base: merge, files: [], additions: 0, deletions: 0 });
});

test("renames, deletions, modes, unusual paths, binary, non-UTF8, submodules and missing newlines remain explicit", async () => {
	const { root, run, reader, commit } = await setup();
	await files.writeFile(join(root, "old name.txt"), "unchanged\n");
	await files.writeFile(join(root, "delete.txt"), "gone\n");
	await files.writeFile(join(root, "mode.sh"), "echo hello\n");
	const first = await commit("Initial");
	await run(["mv", "old name.txt", "new\tname.txt"]);
	await run(["rm", "delete.txt"]);
	await run(["update-index", "--chmod=+x", "mode.sh"]);
	await files.chmod(join(root, "mode.sh"), 0o755);
	await files.writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
	await files.writeFile(join(root, "nonutf.bin"), Buffer.from([255, 254]));
	await files.writeFile(join(root, "no-newline.txt"), "no newline");
	await run(["update-index", "--add", "--cacheinfo", `160000,${first},module`]);
	// Keep the index-only submodule while staging the other files.
	await run(["add", "binary.bin", "nonutf.bin", "no-newline.txt"]);
	await run(["commit", "-m", "Changes"]);
	const sha = (await run(["rev-parse", "HEAD"])).trim();
	const detail = await reader.detail(sha);
	expect(detail.files.find((f) => f.path === "new\tname.txt")).toMatchObject({
		status: "R",
		oldPath: "old name.txt",
	});
	expect(detail.files.find((f) => f.path === "delete.txt")?.status).toBe("D");
	expect(await reader.patch(sha, "mode.sh", false)).toMatchObject({
		oldMode: "100644",
		newMode: "100755",
		hunks: [],
	});
	expect(await reader.patch(sha, "binary.bin", false)).toMatchObject({ binary: true });
	expect(await reader.patch(sha, "nonutf.bin", false)).toMatchObject({ binary: true });
	expect(await reader.patch(sha, "module", false)).toMatchObject({ submodule: true });
	expect((await reader.patch(sha, "no-newline.txt", false)).hunks[0]?.lines.at(-1)?.kind).toBe("marker");
	expect((await reader.patch(sha, "delete.txt", false)).hunks[0]?.lines[0]).toMatchObject({
		kind: "deletion",
		old: 1,
	});
});

test("whitespace filtering preserves file membership while changing displayed statistics", async () => {
	const { root, reader, commit } = await setup();
	await files.writeFile(join(root, "space.txt"), "hello world\n");
	await commit("Initial");
	await files.writeFile(join(root, "space.txt"), "hello    world\n");
	const sha = await commit("Whitespace");
	expect((await reader.detail(sha)).files).toHaveLength(1);
	expect(await reader.patch(sha, "space.txt", false)).toMatchObject({ additions: 1, deletions: 1 });
	expect(await reader.patch(sha, "space.txt", true)).toMatchObject({ additions: 0, deletions: 0, hunks: [] });
});

test("literal unusual paths render as text and configured external diff/textconv cannot execute", async () => {
	const { root, run, reader, commit } = await setup();
	await files.writeFile(join(root, ".gitattributes"), "*.txt diff=blocked\n");
	await files.writeFile(join(root, "line\nbreak.txt"), "<script>alert('text')</script>\n");
	await files.writeFile(join(root, ":literal.txt"), "literal\n");
	const sha = await commit("Unusual names");
	await run(["config", "diff.external", "/bin/false"]);
	await run(["config", "diff.blocked.textconv", "/bin/false"]);
	expect((await reader.detail(sha)).files.map((file) => file.path)).toContain("line\nbreak.txt");
	expect((await reader.patch(sha, "line\nbreak.txt", false)).hunks[0]?.lines[0]?.text).toBe(
		"<script>alert('text')</script>",
	);
	expect((await reader.patch(sha, ":literal.txt", false)).additions).toBe(1);
});

test("patch, file list and transport output limits are explicit", async () => {
	const { root, reader, commit } = await setup();
	await files.writeFile(join(root, "lines.txt"), "line\n".repeat(1500));
	await files.writeFile(join(root, "bytes.txt"), "x".repeat(300000));
	await files.writeFile(join(root, "huge.txt"), "x".repeat(1100000));
	const sha = await commit("Large");
	for (const path of ["lines.txt", "bytes.txt", "huge.txt"])
		expect((await reader.patch(sha, path, false)).truncated).toBe(true);
	for (let i = 0; i < 1001; i++) await files.writeFile(join(root, `file-${i}`), "");
	const many = await commit("Many files");
	const detail = await reader.detail(many);
	expect(detail.files).toHaveLength(1000);
	expect(detail.truncated).toBe(true);
});

test("invalid revisions and paths fail safely and contracts reject malformed responses", async () => {
	const { reader, commit } = await setup();
	const sha = await commit("Empty");
	for (const invalid of ["HEAD", "abc", "-".repeat(40)])
		await expect(reader.detail(invalid)).rejects.toMatchObject({ code: "invalid-request" });
	await expect(reader.detail("f".repeat(40))).rejects.toMatchObject({ code: "file-not-found" });
	for (const path of ["", "../secret", "/absolute", "a/../b", ".git/config", "a\\b"])
		await expect(reader.patch(sha, path, false)).rejects.toMatchObject({ code: "invalid-request" });
	await expect(reader.patch(sha, "missing", false)).rejects.toMatchObject({ code: "file-not-found" });
	expect(commitDetailSchema.safeParse({ sha }).success).toBe(false);
	expect(
		commitPatchSchema.safeParse({ path: "x", hunks: [{ header: "@@", lines: [{ kind: "addition", new: -1 }] }] })
			.success,
	).toBe(false);
});
