import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { afterEach, expect, test } from "vitest";

import { GitTransport } from "./git-transport.ts";
import { GithubSyncClient } from "./github-sync-client.ts";
import { RepositoryClient } from "./repository-client.ts";

const id = "123e4567-e89b-42d3-a456-426614174000";
const remoteUrl = "https://github.com/maxine4j/forge.git";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

const setup = async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-github-sync-"));
	cleanup.push(() => files.rm(root, { recursive: true, force: true }));
	const git = new GitTransport();
	cleanup.push(() => git.close());
	const repositories = new RepositoryClient(root, [], files, git);
	await repositories.prepare(id);
	const local = join(root, "repositories", `${id}.git`);
	const remote = join(root, "remote.git");
	const checkout = join(root, "checkout");
	await git.run(["init", "--bare", "--initial-branch=main", remote]);
	await git.run(["init", "--initial-branch=main", checkout]);
	const run = (args: string[]) =>
		git.run(["-C", checkout, "-c", "user.name=Owner", "-c", "user.email=owner@example.com", ...args]);
	const commit = async (path: string, content: string) => {
		await files.writeFile(join(checkout, path), content);
		await run(["add", "--", path]);
		await run(["commit", "-m", content]);
		return (await run(["rev-parse", "HEAD"])).trim();
	};
	const push = (repo: string) => run(["-c", "protocol.file.allow=always", "push", repo, "HEAD:refs/heads/main"]);
	const first = await commit("base", "base");
	await push(local);
	await push(remote);
	const readRef = async (repo: string) => (await git.run(["-C", repo, "rev-parse", "refs/heads/main"])).trim();
	const hooks: { beforeUpdate?: () => Promise<void>; beforePush?: () => Promise<void> } = {};
	const remoteCommands: string[][] = [];
	const localGit = {
		run: async (args: string[], input?: string) => {
			expect(args).not.toContain(remoteUrl);
			if (args.includes("update-ref")) await hooks.beforeUpdate?.();
			return git.run(args, input);
		},
	};
	const remoteGit = {
		run: async (args: string[]) => {
			remoteCommands.push(args);
			if (args.includes("push")) await hooks.beforePush?.();
			expect(args).toContain(remoteUrl);
			return git.run([
				"-c",
				"protocol.file.allow=always",
				...args.map((arg) => (arg === remoteUrl ? remote : arg)),
			]);
		},
	};
	const client = new GithubSyncClient(root, repositories, localGit, remoteGit);
	return { client, first, run, commit, push, local, remote, readRef, hooks, git, remoteCommands };
};

test("counts live drift and fast-forwards in both directions", async () => {
	const { client, commit, push, local, remote, readRef, remoteCommands } = await setup();
	expect(await client.status(id)).toEqual({ ahead: 0, behind: 0 });
	const remoteHead = await commit("remote", "remote");
	await push(remote);
	expect(await client.status(id)).toEqual({ ahead: 0, behind: 1 });
	expect(await client.sync(id)).toEqual({ outcome: "synced", head: remoteHead });
	expect(await readRef(local)).toBe(remoteHead);
	const localHead = await commit("local", "local");
	await push(local);
	expect(await client.status(id)).toEqual({ ahead: 1, behind: 0 });
	expect(await client.sync(id)).toEqual({ outcome: "synced", head: localHead });
	expect(await readRef(remote)).toBe(localHead);
	for (const command of ["ls-remote", "fetch", "push"]) {
		expect(remoteCommands.some((args) => args.includes(command))).toBe(true);
	}
});

test.each([false, true])("handles divergent histories (conflict: %s)", async (conflict) => {
	const { client, first, run, commit, push, local, remote, readRef, git } = await setup();
	const localHead = await commit("base", "local edit");
	await push(local);
	await run(["reset", "--hard", first]);
	const remoteHead = await commit(conflict ? "base" : "remote", "remote edit");
	await push(remote);
	expect(await client.status(id)).toEqual({ ahead: 1, behind: 1 });
	if (conflict) {
		expect(await client.sync(id)).toEqual({ outcome: "conflict" });
		expect(await readRef(local)).toBe(localHead);
		expect(await readRef(remote)).toBe(remoteHead);
	} else {
		const result = await client.sync(id);
		const head = await readRef(local);
		expect(result).toEqual({ outcome: "synced", head });
		expect(await readRef(remote)).toBe(head);
		expect((await git.run(["-C", local, "show", "-s", "--format=%P", head])).trim()).toBe(
			`${localHead} ${remoteHead}`,
		);
	}
});

test("preserves a local ref changed during sync", async () => {
	const { client, first, commit, push, local, remote, readRef, hooks, git } = await setup();
	const remoteHead = await commit("remote", "remote");
	await push(remote);
	const newer = await commit("newer", "newer");
	await push(local);
	await git.run(["-C", local, "update-ref", "refs/heads/main", first, newer]);
	hooks.beforeUpdate = async () => {
		await git.run(["-C", local, "update-ref", "refs/heads/main", newer, first]);
	};
	expect(await client.sync(id)).toEqual({ outcome: "changed" });
	expect(await readRef(local)).toBe(newer);
	expect(await readRef(remote)).toBe(remoteHead);
});

test("preserves a newer GitHub commit and retains the clean local merge if push is rejected", async () => {
	const { client, first, run, commit, push, local, remote, readRef, hooks } = await setup();
	const localHead = await commit("local", "local");
	await push(local);
	await run(["reset", "--hard", first]);
	const remoteHead = await commit("remote", "remote");
	await push(remote);
	let newer: string | undefined;
	hooks.beforePush = async () => {
		newer = await commit("newer", "newer remote edit");
		await push(remote);
	};
	const result = await client.sync(id);
	const merged = await readRef(local);
	expect(merged).not.toBe(localHead);
	expect(result).toEqual({ outcome: "push-failed", head: merged, localUpdated: true });
	expect(newer).not.toBe(remoteHead);
	expect(await readRef(remote)).toBe(newer);
	expect(await client.status(id)).toEqual({ ahead: 2, behind: 1 });
});

test("rejects unrelated histories before updating either main ref", async () => {
	const { client, first, run, commit, local, remote, readRef } = await setup();
	await run(["switch", "--orphan", "independent"]);
	const remoteHead = await commit("independent", "independent");
	await run(["-c", "protocol.file.allow=always", "push", "--force", remote, "HEAD:refs/heads/main"]);
	expect(await client.status(id)).toEqual({ ahead: 1, behind: 1 });
	expect(await client.sync(id)).toEqual({ outcome: "conflict" });
	expect(await readRef(local)).toBe(first);
	expect(await readRef(remote)).toBe(remoteHead);
});
