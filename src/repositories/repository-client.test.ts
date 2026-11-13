import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { afterEach, expect, test, vi } from "vitest";

import { GitTransport } from "./git-transport.ts";
import { RepositoryClient } from "./repository-client.ts";

const id = "123e4567-e89b-42d3-a456-426614174000";
const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => files.rm(path, { recursive: true, force: true })));
});
const directory = async () => {
	const path = await files.mkdtemp(join(tmpdir(), "forge-repositories-"));
	directories.push(path);
	return path;
};

test("creates a real owned bare repository with main HEAD and recovers after publication", async () => {
	const root = await directory();
	const git = new GitTransport();
	const client = new RepositoryClient(root, ["github.com"], files, git);
	await client.prepare(id);
	await client.prepare(id);
	await client.verify(id);
	const path = join(root, "repositories", `${id}.git`);
	expect(await client.hasUpstream(id)).toBe(false);
	expect(await git.run(["-C", path, "rev-parse", "--is-bare-repository"])).toBe("true\n");
	expect(await git.run(["-C", path, "symbolic-ref", "HEAD"])).toBe("refs/heads/main\n");
	expect((await files.stat(join(root, "repositories"))).mode & 0o777).toBe(0o700);
	expect(await files.readFile(join(path, "forge-owner"))).toBe(id);
});

test("reconciles owned interrupted initialization and refuses unrelated or symlinked paths without deleting data", async () => {
	const root = await directory();
	const git = new GitTransport();
	const client = new RepositoryClient(root, [], files, git);
	const parent = join(root, "repositories", `.${id}.pending`);
	await files.mkdir(parent, { recursive: true, mode: 0o700 });
	await files.writeFile(join(root, "repositories", `.${id}.claim`), "");
	await git.run(["init", "--bare", "--initial-branch=main", join(parent, "repository.git")]);
	await client.prepare(id);
	await client.verify(id);
	const other = "123e4567-e89b-42d3-a456-426614174001";
	const unrelated = join(root, "repositories", `${other}.git`);
	await files.mkdir(unrelated);
	await files.writeFile(join(unrelated, "valuable"), "keep");
	await expect(client.prepare(other)).rejects.toThrow("Repository unavailable");
	expect(await files.readFile(join(unrelated, "valuable"))).toBe("keep");
	const third = "123e4567-e89b-42d3-a456-426614174002";
	await files.symlink(join(root, "repositories", `${id}.git`), join(root, "repositories", `${third}.git`));
	await expect(client.verify(third)).rejects.toThrow("Repository unavailable");
});

test("recovery completes partially initialized owned staging but refuses unclaimed staging", async () => {
	const root = await directory();
	const client = new RepositoryClient(root, [], files, new GitTransport());
	const repositories = join(root, "repositories");
	const staging = join(repositories, `.${id}.pending`);
	await files.mkdir(join(staging, "repository.git", "objects"), { recursive: true, mode: 0o700 });
	await files.writeFile(join(repositories, `.${id}.claim`), "");
	await files.writeFile(join(staging, "repository.git", "valuable"), "preserve partial data");
	await client.prepare(id);
	await client.verify(id);
	expect(await files.readFile(join(repositories, `${id}.git`, "valuable"))).toBe("preserve partial data");
	const other = "123e4567-e89b-42d3-a456-426614174001";
	const unclaimed = join(repositories, `.${other}.pending`);
	await files.mkdir(unclaimed);
	await files.writeFile(join(unclaimed, "valuable"), "keep");
	await expect(client.prepare(other)).rejects.toThrow("Repository unavailable");
	expect(await files.readFile(join(unclaimed, "valuable"))).toBe("keep");
});

test("an empty exclusive claim is recoverable even before the staging directory is created", async () => {
	const root = await directory();
	await files.mkdir(join(root, "repositories"), { mode: 0o700 });
	await files.createFileIfMissing(join(root, "repositories", `.${id}.claim`), "");
	const client = new RepositoryClient(root, [], files, new GitTransport());
	await client.prepare(id);
	await client.verify(id);
});

test("import accepts configured credential-free HTTPS hosts only and uses idempotent bounded Git commands", async () => {
	const root = await directory();
	const real = new GitTransport();
	const run = vi.fn(async (args: string[]) => {
		if (args.includes("fetch")) return "";
		if (args.includes("ls-remote")) return "ref: refs/heads/develop\tHEAD\n";
		return real.run(args);
	});
	const client = new RepositoryClient(root, ["github.com"], files, { run });
	for (const source of [
		"/tmp/repo",
		"file:///tmp/repo",
		"https://evil.example/repo",
		"https://github.com:8443/repo",
		"https://user:token@github.com/repo",
		"http://github.com/repo",
	]) {
		await expect(client.prepare(id, source)).rejects.toThrow("Repository unavailable");
	}
	expect(run).not.toHaveBeenCalled();
	await client.prepare(id, "https://github.com/owner/repo.git");
	expect(await client.hasUpstream(id)).toBe(true);
	expect(await client.upstreamUrl(id)).toBe("https://github.com/owner/repo.git");
	expect(
		run.mock.calls.some(
			([args]) => args.includes("--no-recurse-submodules") && args.includes("+refs/heads/*:refs/heads/*"),
		),
	).toBe(true);
	expect(await real.run(["-C", join(root, "repositories", `${id}.git`), "symbolic-ref", "HEAD"])).toBe(
		"refs/heads/develop\n",
	);
});

test("backfills missing upstream idempotently, preserving existing configuration and data", async () => {
	const root = await directory();
	const git = new GitTransport();
	const client = new RepositoryClient(root, ["example.com"], files, git);
	await client.prepare(id);
	const path = join(root, "repositories", `${id}.git`);
	await git.run(["-C", path, "config", "credential.helper", "preserved-helper"]);
	await client.configureUpstream(id, "https://example.com/first");
	await client.configureUpstream(id, "https://example.com/second");
	await client.prepare(id, "https://example.com/third");
	expect(await client.upstreamUrl(id)).toBe("https://example.com/first");
	expect((await git.run(["-C", path, "config", "--local", "credential.helper"])).trim()).toBe("preserved-helper");
	// Existing invalid remotes remain authoritative but cannot be used for network operations.
	await git.run(["-C", path, "config", "remote.upstream.url", "https://user:secret@example.com/private"]);
	await client.configureUpstream(id, "https://example.com/replacement");
	expect(await client.hasUpstream(id)).toBe(true);
	await expect(client.upstreamUrl(id)).rejects.toThrow();
});

test("interrupted import retains upstream through retry before publication", async () => {
	const root = await directory();
	const git = new GitTransport();
	let interrupted = true;
	const client = new RepositoryClient(root, ["example.com"], files, {
		run: async (args) => {
			if (args.includes("fetch")) {
				if (interrupted) throw new Error("Interrupted fetch");
				return "";
			}
			if (args.includes("ls-remote")) return "";
			return git.run(args);
		},
	});
	await expect(client.prepare(id, "https://example.com/source")).rejects.toThrow();
	const staged = join(root, "repositories", `.${id}.pending`, "repository.git");
	expect((await git.run(["-C", staged, "config", "remote.upstream.url"])).trim()).toBe("https://example.com/source");
	interrupted = false;
	await client.prepare(id, "https://example.com/source");
	expect(await client.upstreamUrl(id)).toBe("https://example.com/source");
});
