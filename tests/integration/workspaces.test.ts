import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { afterEach, expect, test } from "vitest";

import { AccessService } from "../../src/auth/access-service.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { HttpApplication } from "../../src/http/http-application.ts";
import { ProjectRouter } from "../../src/projects/project-router.ts";
import { ProjectService } from "../../src/projects/project-service.ts";
import { ProjectStore } from "../../src/projects/project-store.ts";
import { GitDiffClient } from "../../src/repositories/git-diff-client.ts";
import { GitTransport } from "../../src/repositories/git-transport.ts";
import { RepositoryBrowserClient } from "../../src/repositories/repository-browser-client.ts";
import { RepositoryBrowserRouter } from "../../src/repositories/repository-browser-router.ts";
import { RepositoryBrowserService } from "../../src/repositories/repository-browser-service.ts";
import { RepositoryClient } from "../../src/repositories/repository-client.ts";
import { WorkspaceClient } from "../../src/workspaces/workspace-client.ts";
import { WorkspaceDiffClient } from "../../src/workspaces/workspace-diff-client.ts";
import { WorkspaceRouter } from "../../src/workspaces/workspace-router.ts";
import { WorkspaceService } from "../../src/workspaces/workspace-service.ts";
import { WorkspaceStore } from "../../src/workspaces/workspace-store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const owner = { username: "owner" };
const setup = async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-workspaces-"));
	cleanup.push(() => files.rm(root, { recursive: true, force: true }));
	const db = new SqliteDatabase(join(root, "forge.sqlite"));
	await db.initialize();
	cleanup.push(() => db.close());
	const git = new GitTransport();
	cleanup.push(() => git.close());
	const access = new AccessService({ owner: "owner", origin: "https://forge.example" });
	const repositories = new RepositoryClient(root, [], files, git);
	const projectStore = new ProjectStore(db);
	await projectStore.initialize();
	const projects = new ProjectService(projectStore, repositories, access, randomUUID, () => new Date());
	const project = await projects.create(owner, { name: "Example" });
	const store = new WorkspaceStore(db);
	await store.initialize();
	const client = new WorkspaceClient(root, files, git, repositories);
	const service = new WorkspaceService(
		store,
		client,
		projects,
		access,
		randomUUID,
		() => new Date(),
		new WorkspaceDiffClient(client, git, files, new GitDiffClient(git)),
	);
	return { root, db, git, store, client, service, project, projects, access };
};

test("owned worktrees remain resolvable during a conflicted rebase, but unrelated detached HEADs are rejected", async () => {
	const { service, project, git } = await setup();
	const seed = await service.create(owner, project.id, { name: "Seed" });
	await service.createFile(owner, seed.id, { path: "shared.txt", content: "base\n" });
	await service.stage(owner, seed.id, { paths: ["shared.txt"] });
	const initial = await service.commit(owner, seed.id, { message: "Base", expectedHead: seed.head! });
	const { path } = await service.resolve(owner, seed.id);
	await git.run(["-C", path, "update-ref", "refs/heads/main", initial.head!]);
	const branch = await service.create(owner, project.id, { name: "Ticket" });
	const ticket = await service.resolve(owner, branch.id);
	await files.writeFile(join(ticket.path, "shared.txt"), "ticket\n");
	await git.run(["-C", ticket.path, "add", "shared.txt"]);
	await git.run([
		"-C",
		ticket.path,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-m",
		"Ticket change",
	]);
	await files.writeFile(join(path, "shared.txt"), "main\n");
	await git.run(["-C", path, "add", "shared.txt"]);
	await git.run([
		"-C",
		path,
		"-c",
		"user.name=Test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"-m",
		"Main change",
	]);
	const main = (await git.run(["-C", path, "rev-parse", "HEAD"])).trim();
	await git.run(["-C", path, "update-ref", "refs/heads/main", main]);
	await expect(git.run(["-C", ticket.path, "rebase", "main"])).rejects.toThrow();
	expect((await service.resolve(owner, branch.id)).path).toBe(ticket.path);
	await git.run(["-C", ticket.path, "rebase", "--abort"]);
	await git.run(["-C", ticket.path, "checkout", "--detach"]);
	await expect(service.resolve(owner, branch.id)).rejects.toThrow("workspace-unavailable");
});

test("repository HTTP serves branch-specific trees, files and history behind owner authorization", async () => {
	const { service, project, projects, access, root, git } = await setup();
	const workspace = await service.create(owner, project.id, { name: "Browser" });
	await service.createFile(owner, workspace.id, { path: "README.md", content: "# Browser\n" });
	expect((await service.tree(owner, workspace.id, "")).entries.at(0)?.lastChangedAt).toEqual(expect.any(String));
	await service.stage(owner, workspace.id, { paths: ["README.md"] });
	await service.commit(owner, workspace.id, { message: "Documentation", expectedHead: workspace.head! });
	const client = new RepositoryBrowserClient(root, git, new RepositoryClient(root, [], files, git));
	const browser = new RepositoryBrowserService(client, projects, access);
	const server = createServer(
		new HttpApplication(new ProjectRouter(projects), access)
			.create([new RepositoryBrowserRouter(browser)])
			.callback(),
	);
	cleanup.push(
		() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No listener");
	const url = `http://127.0.0.1:${address.port}/api/projects/${project.id}/repository/`;
	const request = (path: string, user = "owner") => fetch(url + path, { headers: { "x-webauth-user": user } });
	expect((await request("branches", "intruder")).status).toBe(403);
	expect((await (await request("branches")).json()).map((b: { name: string }) => b.name)).toContain("main");
	const branch = encodeURIComponent(workspace.branch);
	const tree = await (await request(`tree?branch=${branch}&path=`)).json();
	const commitUrl = `commits/${tree.head}`;
	expect((await request(commitUrl, "intruder")).status).toBe(403);
	expect((await request(`${commitUrl}/diff?path=README.md`, "intruder")).status).toBe(403);
	expect(await (await request(commitUrl)).json()).toMatchObject({
		sha: tree.head,
		subject: "Documentation",
		files: [{ path: "README.md", status: "A" }],
	});
	expect(await (await request(`${commitUrl}/diff?path=README.md&ignoreWhitespace=false`)).json()).toMatchObject({
		path: "README.md",
		additions: 1,
		truncated: false,
	});
	for (const path of [
		"commits/HEAD",
		"commits/abc",
		`${commitUrl}/diff`,
		`${commitUrl}/diff?path=../secret`,
		`${commitUrl}/diff?path=README.md&ignoreWhitespace=1`,
		`${commitUrl}/diff?path=README.md&path=other`,
	]) {
		const response = await request(path);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid-request" });
	}
	expect((await request(`commits/${"f".repeat(40)}`)).status).toBe(404);
	expect((await request(`${commitUrl}/diff?path=missing`)).status).toBe(404);
	expect(tree.entries.at(0)).toMatchObject({ name: "README.md", lastCommit: { subject: "Documentation" } });
	expect((await (await request("tree?branch=main&path=")).json()).entries).toEqual([]);
	expect(await (await request(`file?branch=${branch}&path=README.md`)).json()).toEqual({
		path: "README.md",
		content: "# Browser\n",
	});
	expect((await (await request(`history?branch=${branch}&offset=0`)).json()).commits.at(0).subject).toBe(
		"Documentation",
	);
	for (const path of [
		"tree?branch=--all",
		"file?branch=main&path=../secret",
		"history?branch=main&offset=-1",
		"tree?branch=main&branch=other",
	])
		expect((await request(path)).status).toBe(400);
	const input = {
		branch: "main",
		expectedHead: (await client.tree(project.id, "main", "")).head,
		message: "Owner batch",
		files: [{ path: "owner.txt", content: "x".repeat(30000) }],
	};
	const commit = (user: string, origin?: string, body: unknown = input) =>
		fetch(url + "commit", {
			method: "POST",
			headers: { "x-webauth-user": user, "content-type": "application/json", ...(origin ? { origin } : {}) },
			body: JSON.stringify(body),
		});
	expect((await commit("intruder", "https://forge.example")).status).toBe(403);
	expect((await commit("owner")).status).toBe(403);
	expect((await commit("owner", "https://other.example.com")).status).toBe(403);
	expect(
		(await commit("owner", "https://forge.example", { ...input, files: [{ path: "../secret", content: "bad" }] }))
			.status,
	).toBe(400);
	expect((await commit("owner", "https://forge.example")).status).toBe(200);
	expect((await client.file(project.id, "main", "owner.txt")).content).toBe("x".repeat(30000));
	expect((await commit("owner", "https://forge.example")).status).toBe(409);
});

test("manual workspace preserves edits, versions, staged and branch diffs, commits and archive across recovery", async () => {
	const { root, git, store, client, service, project } = await setup();
	const workspace = await service.create(owner, project.id, { name: "Manual work" });
	expect(workspace.status).toBe("ready");
	expect(workspace.branch).toBe(`forge/workspace/${workspace.id}`);
	const created = await service.createFile(owner, workspace.id, { path: "hello.txt", content: "first\n" });
	expect(created.content).toBe("first\n");
	await expect(
		service.saveFile(owner, workspace.id, { path: "hello.txt", content: "lost", version: "0".repeat(64) }),
	).rejects.toMatchObject({ code: "file-conflict" });
	const saved = await service.saveFile(owner, workspace.id, {
		path: "hello.txt",
		content: "second\n",
		version: created.version,
	});
	expect(saved.version).not.toBe(created.version);
	expect((await service.diff(owner, workspace.id)).untracked.files.map((file) => file.path)).toEqual(["hello.txt"]);
	await service.stage(owner, workspace.id, { paths: ["hello.txt"] });
	expect((await service.diff(owner, workspace.id)).staged.patch).toContain("+second");
	const status = await service.get(owner, workspace.id);
	await expect(
		service.commit(owner, workspace.id, { message: "stale", expectedHead: "0".repeat(40) }),
	).rejects.toMatchObject({ code: "workspace-conflict" });
	await service.commit(owner, workspace.id, { message: "Add file", expectedHead: status.head! });
	expect((await service.diff(owner, workspace.id)).branch.patch).toContain("+second");
	const path = await service.resolve(owner, workspace.id);
	await files.writeFile(join(path.path, "hello.txt"), "terminal edit\n");
	await expect(
		service.saveFile(owner, workspace.id, { path: "hello.txt", content: "stale editor", version: saved.version }),
	).rejects.toMatchObject({ code: "file-conflict" });
	expect((await service.diff(owner, workspace.id)).unstaged.patch).toContain("+terminal edit");
	await service.recover();
	expect((await service.readFile(owner, workspace.id, "hello.txt")).content).toBe("terminal edit\n");
	expect(
		(
			await git.run(["-C", join(root, "repositories", `${project.id}.git`), "ls-tree", "--name-only", "main"])
		).trim(),
	).toBe("");
	await service.archive(owner, workspace.id);
	expect((await service.get(owner, workspace.id)).status).toBe("archived");
	await expect(service.readFile(owner, workspace.id, "hello.txt")).rejects.toMatchObject({
		code: "workspace-unavailable",
	});
	expect(await files.readFile(join(path.path, "hello.txt"))).toBe("terminal edit\n");
	expect((await store.get(workspace.id))?.status).toBe("archived");
	await client.verify(workspace);
});

test("file access rejects traversal, Git metadata, symlinks and binary files; diffs label binary safely", async () => {
	const { service, project, root } = await setup();
	const workspace = await service.create(owner, project.id, { name: "Bounds" });
	const { path } = await service.resolve(owner, workspace.id);
	await files.writeFile(join(root, "secret"), "private");
	await files.symlink(join(root, "secret"), join(path, "escape"));
	await files.writeFile(join(path, "binary"), Buffer.from([0, 255, 1]));
	for (const name of ["../secret", ".git", ".git/config", "escape", "/etc/passwd"]) {
		await expect(service.readFile(owner, workspace.id, name)).rejects.toBeDefined();
		await expect(service.createFile(owner, workspace.id, { path: name, content: "bad" })).rejects.toBeDefined();
	}
	await expect(service.readFile(owner, workspace.id, "binary")).rejects.toMatchObject({ code: "file-unsupported" });
	expect((await service.tree(owner, workspace.id, "")).entries.map((entry) => entry.name)).toEqual(["binary"]);
	expect((await service.diff(owner, workspace.id)).untracked.files).toEqual([
		{ path: "binary", binary: true },
		{ path: "escape", binary: true },
	]);
});

test("creating intent recovers an existing owned worktree without overwriting files and unrelated paths fail closed", async () => {
	const { service, project, store, client, root } = await setup();
	const record = {
		id: randomUUID(),
		projectId: project.id,
		name: "Interrupted",
		branch: "",
		baseSha: undefined,
		createdAt: new Date().toISOString(),
		status: "creating" as const,
	};
	record.branch = `forge/workspace/${record.id}`;
	await store.insert(record);
	await client.prepare(record);
	await files.writeFile(join(root, "worktrees", record.id, "kept"), "valuable");
	await service.recover();
	expect((await service.get(owner, record.id)).status).toBe("ready");
	expect((await service.readFile(owner, record.id, "kept")).content).toBe("valuable");
	const unrelated = { ...record, id: randomUUID() };
	unrelated.branch = `forge/workspace/${unrelated.id}`;
	await store.insert(unrelated);
	await files.mkdir(join(root, "worktrees", unrelated.id));
	await files.writeFile(join(root, "worktrees", unrelated.id, "valuable"), "preserved");
	await service.recover();
	expect((await service.get(owner, unrelated.id)).status).toBe("failed");
	expect(await files.readFile(join(root, "worktrees", unrelated.id, "valuable"))).toBe("preserved");
});

test("HTTP validates owner, origin, file byte bounds and versions, with safe fixed errors", async () => {
	const { service, project, projects, access } = await setup();
	const server = createServer(
		new HttpApplication(new ProjectRouter(projects), access).create([new WorkspaceRouter(service)]).callback(),
	);
	cleanup.push(
		() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No listener");
	const headers = { "x-webauth-user": "owner", origin: "https://forge.example", "content-type": "application/json" };
	const request = (path: string, options: RequestInit = {}) =>
		fetch(`http://127.0.0.1:${address.port}${path}`, { ...options, headers: options.headers ?? headers });
	const created = await request(`/api/projects/${project.id}/workspaces`, {
		method: "POST",
		body: JSON.stringify({ name: "HTTP" }),
	});
	expect(created.status).toBe(201);
	const workspace = await created.json();
	expect(workspace).not.toHaveProperty("path");
	const content = "x".repeat(20000);
	const file = await request(`/api/workspaces/${workspace.id}/file`, {
		method: "POST",
		body: JSON.stringify({ path: "large.txt", content }),
	});
	expect(file.status).toBe(201);
	const value = await file.json();
	expect(value.content).toBe(content);
	expect(
		(
			await request(`/api/workspaces/${workspace.id}/file`, {
				method: "PUT",
				body: JSON.stringify({ path: "large.txt", content: "lost", version: "0".repeat(64) }),
			})
		).status,
	).toBe(409);
	expect(
		(
			await request(`/api/workspaces/${workspace.id}/file`, {
				method: "PUT",
				headers: { ...headers, origin: "https://evil.example" },
				body: JSON.stringify(value),
			})
		).status,
	).toBe(403);
	const binary = await request(`/api/workspaces/${workspace.id}/file`, {
		method: "POST",
		body: JSON.stringify({ path: "too-big", content: "é".repeat(140000) }),
	});
	expect(binary.status).toBe(415);
	expect(await binary.json()).toEqual({ error: "file-unsupported" });
	expect(
		(await request(`/api/projects`, { method: "POST", body: JSON.stringify({ name: "x".repeat(20000) }) })).status,
	).toBe(413);
	expect((await request(`/api/workspaces/${workspace.id}/file?path=.git`)).status).toBe(400);
	expect((await request(`/api/workspaces/${randomUUID()}`)).status).toBe(404);
});

test("concurrent versioned writes have exactly one winner and file staging cannot recursively include restricted metadata", async () => {
	const { service, project } = await setup();
	const workspace = await service.create(owner, project.id, { name: "Concurrent" });
	const file = await service.createFile(owner, workspace.id, { path: "same", content: "initial" });
	const saves = await Promise.allSettled(
		["one", "two"].map((content) => service.saveFile(owner, workspace.id, { ...file, content })),
	);
	expect(saves.filter((result) => result.status === "fulfilled")).toHaveLength(1);
	expect(saves.filter((result) => result.status === "rejected")).toHaveLength(1);
	const { path } = await service.resolve(owner, workspace.id);
	await files.mkdir(join(path, "directory"));
	await files.writeFile(join(path, "directory", ".forge-private"), "metadata");
	await expect(service.stage(owner, workspace.id, { paths: ["directory"] })).rejects.toMatchObject({
		code: "file-unsupported",
	});
});

test("stage and unstage a tracked deletion after all parent directories are removed", async () => {
	const { service, project } = await setup();
	const workspace = await service.create(owner, project.id, { name: "Deleted parents" });
	const { path } = await service.resolve(owner, workspace.id);
	await files.mkdir(join(path, "nested", "parent"), { recursive: true });
	await service.createFile(owner, workspace.id, { path: "nested/parent/file.txt", content: "tracked\n" });
	await service.stage(owner, workspace.id, { paths: ["nested/parent/file.txt"] });
	await service.commit(owner, workspace.id, { message: "Track nested file", expectedHead: workspace.head! });
	await files.rm(join(path, "nested"), { recursive: true });
	await service.stage(owner, workspace.id, { paths: ["nested/parent/file.txt"] });
	expect((await service.diff(owner, workspace.id)).staged.patch).toContain("-tracked");
	await service.unstage(owner, workspace.id, { paths: ["nested/parent/file.txt"] });
	expect((await service.diff(owner, workspace.id)).staged.files).toEqual([]);
	expect((await service.diff(owner, workspace.id)).unstaged.patch).toContain("-tracked");
	await expect(
		service.createFile(owner, workspace.id, { path: "nested/parent/file.txt", content: "blocked" }),
	).rejects.toMatchObject({ code: "file-not-found" });
});

test("bounded diff sections retain paths and identify non-UTF8 staged content as binary", async () => {
	const { service, project } = await setup();
	const workspace = await service.create(owner, project.id, { name: "Bounded" });
	const { path } = await service.resolve(owner, workspace.id);
	await files.writeFile(join(path, "not-utf8"), Buffer.from([255, 254, 10]));
	await service.stage(owner, workspace.id, { paths: ["not-utf8"] });
	const binary = (await service.diff(owner, workspace.id)).staged;
	expect(binary.files).toEqual([{ path: "not-utf8", binary: true }]);
	expect(binary.patch).toBe("");
	await files.writeFile(join(path, "many-lines"), "line\n".repeat(5000));
	await service.stage(owner, workspace.id, { paths: ["many-lines"] });
	const staged = (await service.diff(owner, workspace.id)).staged;
	expect(staged.truncated).toBe(true);
	expect(staged.patch.split("\n").length).toBeLessThanOrEqual(1000);
	expect(Buffer.byteLength(staged.patch)).toBeLessThanOrEqual(262144);
	for (let index = 0; index < 105; index++) await files.writeFile(join(path, `untracked-${index}`), "new\n");
	const untracked = (await service.diff(owner, workspace.id)).untracked;
	expect(untracked.files).toHaveLength(100);
	expect(untracked.truncated).toBe(true);
});

test("a terminal switching HEAD to main disables Forge writes and retains original files", async () => {
	const { service, project, git } = await setup();
	const workspace = await service.create(owner, project.id, { name: "Protected" });
	const { path } = await service.resolve(owner, workspace.id);
	await git.run(["-C", path, "switch", "main"]);
	await expect(service.createFile(owner, workspace.id, { path: "blocked", content: "no" })).rejects.toMatchObject({
		code: "workspace-unavailable",
	});
	expect(await files.readFile(join(path, "blocked"))).toBeUndefined();
	await service.recover();
	expect((await service.get(owner, workspace.id)).status).toBe("failed");
});

test("interrupted creation retains its original base even when main advances to its branch before recovery", async () => {
	const { service, project, store, client, git, root } = await setup();
	const record = {
		id: randomUUID(),
		projectId: project.id,
		name: "Base",
		branch: "",
		createdAt: new Date().toISOString(),
		status: "creating" as const,
	};
	record.branch = `forge/workspace/${record.id}`;
	await store.insert(record);
	const originalBase = await client.prepare(record);
	const path = await client.location(record);
	await files.writeFile(join(path, "work"), "kept");
	await client.stage(record, ["work"], false);
	const head = await client.commit(record, "Interrupted commit", originalBase);
	await git.run([
		"-C",
		join(root, "repositories", `${project.id}.git`),
		"update-ref",
		"refs/heads/main",
		head,
		originalBase,
	]);
	await service.recover();
	expect((await service.get(owner, record.id)).baseSha).toBe(originalBase);
});

test("workspace metadata and working files survive closing and reopening SQLite", async () => {
	const { service, project, db, root, client, projects, access, git } = await setup();
	const workspace = await service.create(owner, project.id, { name: "Persistent" });
	await service.createFile(owner, workspace.id, { path: "persisted", content: "saved" });
	await db.close();
	const reopened = new SqliteDatabase(join(root, "forge.sqlite"));
	cleanup.push(() => reopened.close());
	await reopened.initialize();
	const store = new WorkspaceStore(reopened);
	await store.initialize();
	const resumed = new WorkspaceService(
		store,
		client,
		projects,
		access,
		randomUUID,
		() => new Date(),
		new WorkspaceDiffClient(client, git, files, new GitDiffClient(git)),
	);
	await resumed.recover();
	expect(await resumed.get(owner, workspace.id)).toEqual(workspace);
	expect((await resumed.readFile(owner, workspace.id, "persisted")).content).toBe("saved");
});

test("workspaces never adopt an unclaimed existing branch and tag-only repositories are not initialized as empty", async () => {
	const { service, project, store, client, git, root } = await setup();
	const ready = await service.create(owner, project.id, { name: "Seed" });
	const repository = join(root, "repositories", `${project.id}.git`);
	const record = {
		id: randomUUID(),
		projectId: project.id,
		name: "Foreign",
		branch: "",
		createdAt: new Date().toISOString(),
		status: "creating" as const,
	};
	record.branch = `forge/workspace/${record.id}`;
	await store.insert(record);
	await git.run(["-C", repository, "branch", record.branch, "main"]);
	await expect(client.prepare(record)).rejects.toMatchObject({ code: "workspace-unavailable" });
	expect(await files.readFile(join(root, "worktrees", `.${record.id}.claim`))).toBeUndefined();
	await service.archive(owner, ready.id);
	await git.run(["-C", repository, "update-ref", "refs/tags/kept", ready.head!]);
	await git.run(["-C", repository, "update-ref", "-d", `refs/heads/${ready.branch}`]);
	await git.run(["-C", repository, "update-ref", "-d", `refs/heads/${record.branch}`]);
	await git.run(["-C", repository, "update-ref", "-d", "refs/heads/main"]);
	await expect(service.create(owner, project.id, { name: "Tag only" })).rejects.toMatchObject({
		code: "workspace-unavailable",
	});
	expect((await git.run(["-C", repository, "for-each-ref", "--format=%(refname)"])).trim()).toBe("refs/tags/kept");
});

test("branch diffs exclude main-only changes and staging includes nested file deletions", async () => {
	const { service, project, git, root } = await setup();
	const first = await service.create(owner, project.id, { name: "First" });
	await service.createFile(owner, first.id, { path: "branch-only", content: "first\n" });
	await service.stage(owner, first.id, { paths: ["branch-only"] });
	await service.unstage(owner, first.id, { paths: ["branch-only"] });
	expect((await service.diff(owner, first.id)).staged.files).toEqual([]);
	await service.stage(owner, first.id, { paths: ["branch-only"] });
	await service.commit(owner, first.id, { message: "First branch", expectedHead: first.head! });
	const second = await service.create(owner, project.id, { name: "Second" });
	const secondPath = (await service.resolve(owner, second.id)).path;
	await files.mkdir(join(secondPath, "nested"));
	await service.createFile(owner, second.id, { path: "nested/main-only", content: "second\n" });
	await service.stage(owner, second.id, { paths: ["nested/main-only"] });
	const committed = await service.commit(owner, second.id, { message: "Second branch", expectedHead: second.head! });
	await git.run([
		"-C",
		join(root, "repositories", `${project.id}.git`),
		"update-ref",
		"refs/heads/main",
		committed.head!,
		second.head!,
	]);
	const diff = await service.diff(owner, first.id);
	expect(diff.baseSha).toBe(first.baseSha);
	expect(diff.branch.files.map((file) => file.path)).toEqual(["branch-only"]);
	await files.rm(join(secondPath, "nested"), { recursive: true });
	await service.stage(owner, second.id, { paths: ["nested/main-only"] });
	expect((await service.diff(owner, second.id)).staged.patch).toContain("-second");
});
