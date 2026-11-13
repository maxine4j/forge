import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { afterEach, expect, test } from "vitest";

import { GitTransport } from "./git-transport.ts";
import { RepositoryClient } from "./repository-client.ts";
import { UpstreamSyncClient } from "./upstream-sync-client.ts";

const id = "123e4567-e89b-42d3-a456-426614174000";
const remoteUrl = "https://github.com/maxine4j/forge.git";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

const setup = async (branch = "main") => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-upstream-sync-"));
	cleanup.push(() => files.rm(root, { recursive: true, force: true }));
	const git = new GitTransport();
	cleanup.push(() => git.close());
	const repositories = new RepositoryClient(root, ["github.com"], files, git);
	await repositories.prepare(id);
	await repositories.configureUpstream(id, remoteUrl);
	const local = join(root, "repositories", `${id}.git`);
	const remote = join(root, "remote.git");
	const checkout = join(root, "checkout");
	await git.run(["init", "--bare", `--initial-branch=${branch}`, remote]);
	await git.run(["init", `--initial-branch=${branch}`, checkout]);
	const run = (args: string[]) =>
		git.run(["-C", checkout, "-c", "user.name=Owner", "-c", "user.email=owner@example.com", ...args]);
	const commit = async (path: string, content: string) => {
		await files.writeFile(join(checkout, path), content);
		await run(["add", "--", path]);
		await run(["commit", "-m", content]);
		return (await run(["rev-parse", "HEAD"])).trim();
	};
	const push = (repo: string) => run(["-c", "protocol.file.allow=always", "push", repo, `HEAD:refs/heads/${branch}`]);
	const first = await commit("base", "base");
	await push(local);
	await push(remote);
	const readRef = async (repo: string) => (await git.run(["-C", repo, "rev-parse", `refs/heads/${branch}`])).trim();
	const hooks: {
		beforeUpdate?: () => Promise<void>;
		beforePush?: () => Promise<void>;
		afterDiscovery?: () => Promise<void>;
	} = {};
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
			const output = await git.run([
				"-c",
				"protocol.file.allow=always",
				...args.map((arg) => (arg === remoteUrl ? remote : arg)),
			]);
			if (args.includes("ls-remote")) await hooks.afterDiscovery?.();
			return output;
		},
	};
	const client = new UpstreamSyncClient(root, repositories, localGit, remoteGit);
	return { client, first, run, commit, push, local, remote, readRef, hooks, git, remoteCommands, repositories };
};

test.each(["main", "master", "release/stable"])(
	"counts live drift and fast-forwards %s in both directions",
	async (branch) => {
		const { client, commit, push, local, remote, readRef, remoteCommands } = await setup(branch);
		expect(await client.status(id)).toEqual({ branch, ahead: 0, behind: 0 });
		const remoteHead = await commit("remote", "remote");
		await push(remote);
		expect(await client.status(id)).toEqual({ branch, ahead: 0, behind: 1 });
		expect(await client.sync(id)).toEqual({ outcome: "synced", branch, head: remoteHead });
		expect(await readRef(local)).toBe(remoteHead);
		const localHead = await commit("local", "local");
		await push(local);
		expect(await client.status(id)).toEqual({ branch, ahead: 1, behind: 0 });
		expect(await client.sync(id)).toEqual({ outcome: "synced", branch, head: localHead });
		expect(await readRef(remote)).toBe(localHead);
		for (const command of ["ls-remote", "fetch", "push"]) {
			expect(remoteCommands.some((args) => args.includes(command))).toBe(true);
		}
	},
);

test.each([false, true])("handles divergent histories (conflict: %s)", async (conflict) => {
	const { client, first, run, commit, push, local, remote, readRef, git } = await setup();
	const localHead = await commit("base", "local edit");
	await push(local);
	await run(["reset", "--hard", first]);
	const remoteHead = await commit(conflict ? "base" : "remote", "remote edit");
	await push(remote);
	expect(await client.status(id)).toEqual({ branch: "main", ahead: 1, behind: 1 });
	if (conflict) {
		expect(await client.sync(id)).toEqual({ outcome: "conflict" });
		expect(await readRef(local)).toBe(localHead);
		expect(await readRef(remote)).toBe(remoteHead);
	} else {
		const result = await client.sync(id);
		const head = await readRef(local);
		expect(result).toEqual({ outcome: "synced", branch: "main", head });
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
	expect(await client.status(id)).toEqual({ branch: "main", ahead: 2, behind: 1 });
	hooks.beforePush = undefined;
	expect(await client.sync(id)).toMatchObject({ outcome: "synced", branch: "main" });
	expect(await readRef(local)).toBe(await readRef(remote));
});

test("uses the changed live upstream default without changing Forge HEAD", async () => {
	const { client, first, local, remote, git } = await setup();
	for (const repository of [local, remote]) {
		await git.run(["-C", repository, "update-ref", "refs/heads/release/stable", first]);
	}
	await git.run(["-C", remote, "symbolic-ref", "HEAD", "refs/heads/release/stable"]);
	expect(await client.status(id)).toEqual({ branch: "release/stable", ahead: 0, behind: 0 });
	expect(await client.sync(id)).toEqual({ outcome: "synced", branch: "release/stable", head: first });
	expect((await git.run(["-C", local, "symbolic-ref", "HEAD"])).trim()).toBe("refs/heads/main");
});

test.each(["missing-local", "missing-remote", "detached-head", "unreadable"])(
	"rejects unavailable target %s without creating refs",
	async (scenario) => {
		const { client, first, local, remote, git, repositories } = await setup();
		if (scenario === "missing-local") await git.run(["-C", local, "update-ref", "-d", "refs/heads/main"]);
		if (scenario === "missing-remote") await git.run(["-C", remote, "symbolic-ref", "HEAD", "refs/heads/missing"]);
		if (scenario === "detached-head") await git.run(["-C", remote, "update-ref", "--no-deref", "HEAD", first]);
		if (scenario === "unreadable") {
			await git.run(["-C", local, "config", "remote.upstream.url", "https://evil.example/private"]);
			await expect(repositories.upstreamUrl(id)).rejects.toThrow();
		}
		await expect(client.status(id)).rejects.toThrow();
		await expect(client.sync(id)).rejects.toThrow();
		if (scenario === "missing-local")
			await expect(git.run(["-C", local, "rev-parse", "--verify", "refs/heads/main"])).rejects.toThrow();
	},
);

test("captures URL and branch for fetch, merge and push even if configuration and default change", async () => {
	const { client, first, run, commit, push, local, remote, git, hooks, readRef } = await setup();
	await commit("local", "local");
	await push(local);
	await run(["reset", "--hard", first]);
	await commit("remote", "remote");
	await push(remote);
	hooks.afterDiscovery = async () => {
		await git.run(["-C", local, "config", "remote.upstream.url", "https://other.example/repo"]);
		await git.run(["-C", remote, "update-ref", "refs/heads/master", first]);
		await git.run(["-C", remote, "symbolic-ref", "HEAD", "refs/heads/master"]);
	};
	expect(await client.sync(id)).toMatchObject({ outcome: "synced", branch: "main" });
	const head = await readRef(local);
	expect(await readRef(remote)).toBe(head);
	expect((await git.run(["-C", remote, "rev-parse", "refs/heads/master"])).trim()).toBe(first);
});

test.each(["refs/tags/v1", "refs/heads/../invalid", "refs/heads/-invalid"])(
	"rejects invalid symbolic HEAD %s",
	async (ref) => {
		const { first, local, git, repositories, readRef } = await setup();
		const client = new UpstreamSyncClient(join(local, "../.."), repositories, git, {
			run: async () => `ref: ${ref}\tHEAD\n${first}\tHEAD\n`,
		});
		await expect(client.status(id)).rejects.toThrow();
		await expect(client.sync(id)).rejects.toThrow();
		expect(await readRef(local)).toBe(first);
	},
);

test("rejects unrelated histories before updating either main ref", async () => {
	const { client, first, run, commit, local, remote, readRef } = await setup();
	await run(["switch", "--orphan", "independent"]);
	const remoteHead = await commit("independent", "independent");
	await run(["-c", "protocol.file.allow=always", "push", "--force", remote, "HEAD:refs/heads/main"]);
	expect(await client.status(id)).toEqual({ branch: "main", ahead: 1, behind: 1 });
	expect(await client.sync(id)).toEqual({ outcome: "conflict" });
	expect(await readRef(local)).toBe(first);
	expect(await readRef(remote)).toBe(remoteHead);
});
