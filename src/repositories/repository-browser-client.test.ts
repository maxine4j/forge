import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { afterEach, expect, test } from "vitest";

import { GitTransport } from "./git-transport.ts";
import { RepositoryBrowserClient } from "./repository-browser-client.ts";
import { RepositoryClient } from "./repository-client.ts";

const id = "123e4567-e89b-42d3-a456-426614174000";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const setup = async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-browser-"));
	cleanup.push(() => files.rm(root, { recursive: true, force: true }));
	const git = new GitTransport();
	cleanup.push(() => git.close());
	const repositories = new RepositoryClient(root, [], files, git);
	await repositories.prepare(id);
	const checkout = join(root, "checkout");
	await git.run(["init", "--initial-branch=main", checkout]);
	const run = (args: string[]) =>
		git.run(["-C", checkout, "-c", "user.name=Owner", "-c", "user.email=owner@example.com", ...args]);
	await files.mkdir(join(checkout, "src"));
	await files.writeFile(join(checkout, "README.md"), "# Hello\n");
	await files.writeFile(join(checkout, "src", "app.ts"), "export const value = 1;\n");
	await files.symlink("README.md", join(checkout, "link"));
	await run(["add", "."]);
	await run(["commit", "-m", "Initial files"]);
	const first = (await run(["rev-parse", "HEAD"])).trim();
	await run(["switch", "-c", "feature/nested"]);
	await files.writeFile(join(checkout, "README.md"), "# Feature\n");
	await run(["commit", "-am", "Feature documentation"]);
	await run([
		"-c",
		"protocol.file.allow=always",
		"push",
		join(root, "repositories", `${id}.git`),
		"main",
		"feature/nested",
	]);
	const client = new RepositoryBrowserClient(root, git, repositories);
	return { client, first, checkout };
};

test("branches, trees, last-change metadata, files and paginated history follow the selected branch", async () => {
	const { client, first } = await setup();
	expect((await client.branches(id)).map((b) => b.name)).toEqual(["feature/nested", "main"]);
	const tree = await client.tree(id, "feature/nested", "");
	expect(tree.entries.map((e) => e.name)).toEqual(["src", "README.md"]);
	expect(tree.entries.find((e) => e.name === "README.md")?.lastCommit?.subject).toBe("Feature documentation");
	expect(tree.entries.find((e) => e.name === "src")?.lastCommit?.sha).toBe(first);
	expect(tree.entries.every((e) => !Number.isNaN(Date.parse(e.lastCommit!.date)))).toBe(true);
	expect((await client.tree(id, "main", "src")).entries.at(0)?.path).toBe("src/app.ts");
	expect((await client.file(id, "main", "README.md")).content).toBe("# Hello\n");
	expect((await client.file(id, "feature/nested", "README.md")).content).toBe("# Feature\n");
	const history = await client.history(id, "feature/nested", 0, 1);
	expect(history.commits.map((c) => c.subject)).toEqual(["Feature documentation"]);
	expect(history.hasMore).toBe(true);
	expect((await client.history(id, "feature/nested", 1, 1)).commits.at(0)?.sha).toBe(first);
	expect((await client.history(id, "main", 0, 30)).commits).toHaveLength(1);
});

test("invalid refs, traversal, missing files and symlink blobs fail safely", async () => {
	const { client } = await setup();
	for (const branch of ["--all", "main^{tree}", "main:README.md", "missing"]) {
		await expect(client.tree(id, branch, "")).rejects.toMatchObject({ code: "invalid-request" });
	}
	await expect(client.file(id, "main", "../secret")).rejects.toMatchObject({ code: "invalid-request" });
	await expect(client.file(id, "main", "missing")).rejects.toMatchObject({ code: "file-not-found" });
	await expect(client.file(id, "main", "link")).rejects.toMatchObject({ code: "file-unsupported" });
});

test("empty repositories have no fabricated branches", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-empty-"));
	cleanup.push(() => files.rm(root, { recursive: true, force: true }));
	const git = new GitTransport();
	cleanup.push(() => git.close());
	const repositories = new RepositoryClient(root, [], files, git);
	await repositories.prepare(id);
	expect(await new RepositoryBrowserClient(root, git, repositories).branches(id)).toEqual([]);
});

test("one branch commit applies all drafts atomically without altering other branches or checkout files", async () => {
	const { client, checkout } = await setup();
	const head = (await client.tree(id, "feature/nested", "")).head;
	const main = await client.tree(id, "main", "");
	const result = await client.commit(id, {
		branch: "feature/nested",
		expectedHead: head,
		message: "Batch edit",
		files: [
			{ path: "README.md", content: "# Updated\n" },
			{ path: "new/nested.ts", content: "export {};\n" },
		],
	});
	expect(result.head).not.toBe(head);
	expect((await client.file(id, "feature/nested", "README.md")).content).toBe("# Updated\n");
	expect((await client.file(id, "feature/nested", "new/nested.ts")).content).toBe("export {};\n");
	expect(await client.tree(id, "main", "")).toEqual(main);
	expect(await files.readFile(join(checkout, "README.md"))).toBe("# Feature\n");
	expect((await client.history(id, "feature/nested", 0, 30)).commits.map((c) => c.subject)).toEqual([
		"Batch edit",
		"Feature documentation",
		"Initial files",
	]);
	await expect(
		client.commit(id, {
			branch: "feature/nested",
			expectedHead: head,
			message: "Stale",
			files: [{ path: "README.md", content: "overwrite" }],
		}),
	).rejects.toMatchObject({ code: "workspace-conflict" });
	expect((await client.file(id, "feature/nested", "README.md")).content).toBe("# Updated\n");
});

test("concurrent commits publish exactly one complete batch", async () => {
	const { client, first } = await setup();
	const results = await Promise.allSettled(
		["one", "two"].map((content) =>
			client.commit(id, {
				branch: "main",
				expectedHead: first,
				message: content,
				files: [
					{ path: "README.md", content },
					{ path: "src/app.ts", content },
				],
			}),
		),
	);
	expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	const failure = results.find((result) => result.status === "rejected");
	expect(failure?.status === "rejected" && failure.reason.code).toBe("workspace-conflict");
	expect((await client.file(id, "main", "README.md")).content).toBe(
		(await client.file(id, "main", "src/app.ts")).content,
	);
});

test("owner commits may target main; unsafe paths, duplicate drafts and symlink replacement fail before ref updates", async () => {
	const { client, first } = await setup();
	for (const paths of [["../secret"], ["link/child"], ["link"], ["README.md", "README.md"], ["src", "src/app.ts"]]) {
		await expect(
			client.commit(id, {
				branch: "main",
				expectedHead: first,
				message: "Invalid",
				files: paths.map((path) => ({ path, content: "x" })),
			}),
		).rejects.toBeDefined();
		expect((await client.tree(id, "main", "")).head).toBe(first);
	}
	await client.commit(id, {
		branch: "main",
		expectedHead: first,
		message: "Owner edit",
		files: [{ path: "src/app.ts", content: "export const value = 2;\n" }],
	});
	expect((await client.file(id, "main", "src/app.ts")).content).toBe("export const value = 2;\n");
});
