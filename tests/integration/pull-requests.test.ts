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
import { PullRequestClient } from "../../src/pull-requests/pull-request-client.ts";
import { PullRequestRouter } from "../../src/pull-requests/pull-request-router.ts";
import { PullRequestService } from "../../src/pull-requests/pull-request-service.ts";
import { PullRequestStore } from "../../src/pull-requests/pull-request-store.ts";
import { GitDiffClient } from "../../src/repositories/git-diff-client.ts";
import { GitTransport } from "../../src/repositories/git-transport.ts";
import { RepositoryClient } from "../../src/repositories/repository-client.ts";
import { WorkspaceClient } from "../../src/workspaces/workspace-client.ts";
import { WorkspaceDiffClient } from "../../src/workspaces/workspace-diff-client.ts";
import { WorkspaceService } from "../../src/workspaces/workspace-service.ts";
import { WorkspaceStore } from "../../src/workspaces/workspace-store.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});
const owner = { username: "owner" };
const setup = async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-pr-"));
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
	const project = await projects.create(owner, { name: "PR project" });
	const workspaces = new WorkspaceStore(db);
	await workspaces.initialize();
	const wc = new WorkspaceClient(root, files, git, repositories);
	const ws = new WorkspaceService(
		workspaces,
		wc,
		projects,
		access,
		randomUUID,
		() => new Date(),
		new WorkspaceDiffClient(wc, git, files, new GitDiffClient(git)),
	);
	const workspace = await ws.create(owner, project.id, { name: "PR source" });
	const store = new PullRequestStore(db);
	await store.initialize();
	const client = new PullRequestClient(ws, git, new GitDiffClient(git));
	const service = new PullRequestService(store, client, access, randomUUID, () => new Date());
	const app = new HttpApplication(new ProjectRouter(projects), access).create([new PullRequestRouter(service)]);
	const server = createServer(app.callback());
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanup.push(
		() =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No address");
	const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
		fetch(`http://127.0.0.1:${address.port}${path}`, {
			method,
			headers: {
				"x-webauth-user": "owner",
				origin: "https://forge.example",
				"content-type": "application/json",
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const commit = async (content: string) => {
		const previous = await ws.get(owner, workspace.id);
		const old = await files.readFile(join((await ws.resolve(owner, workspace.id)).path, "review.txt"));
		if (old === undefined) await ws.createFile(owner, workspace.id, { path: "review.txt", content });
		else {
			const file = await ws.readFile(owner, workspace.id, "review.txt");
			await ws.saveFile(owner, workspace.id, { path: "review.txt", content, version: file.version });
		}
		await ws.stage(owner, workspace.id, { paths: ["review.txt"] });
		return ws.commit(owner, workspace.id, { expectedHead: previous.head!, message: "PR work" });
	};
	return { root, db, git, project, workspace, ws, wc, projects, store, client, service, access, request, commit };
};

test("real HTTP PR lifecycle binds commits, persists reviews, protects main and preserves unavailable discussion", async () => {
	const f = await setup();
	const initial = await f.service.preview(owner, f.workspace.id);
	await expect(
		f.service.create(owner, f.project.id, {
			workspaceId: f.workspace.id,
			title: "Empty",
			body: "",
			expectedHead: initial.revision.head,
			expectedBase: initial.revision.baseSha,
		}),
	).rejects.toMatchObject({ code: "no-changes" });
	await f.commit("committed\n");
	await f.ws.createFile(owner, f.workspace.id, { path: "not-committed", content: "local" });
	const preview = await (await f.request(`/api/workspaces/${f.workspace.id}/pull-request-revision`)).json();
	const expected = { expectedHead: preview.revision.head, expectedBase: preview.revision.baseSha };
	const response = await f.request(`/api/projects/${f.project.id}/pull-requests`, "POST", {
		workspaceId: f.workspace.id,
		title: "Review",
		body: "Description",
		...expected,
	});
	expect(response.status).toBe(201);
	const pr = await response.json();
	const url = `/api/pull-requests/${pr.id}`;
	const diff = await (await f.request(`${url}/diff`)).json();
	expect(diff.comparison).toBe("merge-base(main, workspace)..workspace (committed)");
	expect(diff.diff.files.map((entry: { path: string }) => entry.path)).toEqual(["review.txt"]);
	expect((await f.request(`${url}/reviews`, "POST", { ...expected, decision: "approve", body: "good" })).status).toBe(
		200,
	);
	expect((await (await f.request(url)).json()).approval).toBe("approved");
	expect(
		(
			await f.request(
				`${url}/comments`,
				"POST",
				{ ...expected, body: "discussion" },
				{ origin: "https://evil.example" },
			)
		).status,
	).toBe(403);
	expect((await f.request(url, "GET", undefined, { "x-webauth-user": "other" })).status).toBe(403);
	expect(
		(await f.request(`${url}/comments`, "POST", { ...expected, body: "discussion", path: "unreviewed" })).status,
	).toBe(400);
	await f.commit("new revision\n");
	expect((await (await f.request(url)).json()).approval).toBe("stale");
	expect(
		(await f.request(`${url}/reviews`, "POST", { ...expected, decision: "approve", body: "stale" })).status,
	).toBe(409);
	const current = await f.service.preview(owner, f.workspace.id);
	const next = { expectedHead: current.revision.head, expectedBase: current.revision.baseSha };
	expect(
		(await f.request(`${url}/reviews`, "POST", { ...next, decision: "request-changes", body: "fix" })).status,
	).toBe(200);
	expect((await f.service.get(owner, pr.id)).approval).toBe("requested-changes");
	expect((await f.request(url, "PATCH", { ...next, status: "closed" })).status).toBe(200);
	expect((await f.request(`${url}/comments`, "POST", { ...next, body: "closed" })).status).toBe(409);
	expect((await f.request(url, "PATCH", { ...next, status: "open", title: "Reopened" })).status).toBe(200);
	expect((await f.request(`${url}/comments`, "POST", { ...next, body: "retained" })).status).toBe(200);
	expect(await (await f.request(`/api/projects/${f.project.id}/pull-requests`)).json()).toHaveLength(1);
	expect((await f.request(`${url}/merge`, "POST", next)).status).toBe(404);
	expect(
		(await f.git.run(["-C", join(f.root, "repositories", `${f.project.id}.git`), "rev-parse", "main"])).trim(),
	).toBe(initial.revision.baseSha);
	await f.db.close();
	const reopened = new SqliteDatabase(join(f.root, "forge.sqlite"));
	await reopened.initialize();
	cleanup.push(() => reopened.close());
	const resumedStore = new PullRequestStore(reopened);
	await resumedStore.initialize();
	const wsStore = new WorkspaceStore(reopened);
	const resumedWs = new WorkspaceService(
		wsStore,
		f.wc,
		f.projects,
		f.access,
		randomUUID,
		() => new Date(),
		new WorkspaceDiffClient(f.wc, f.git, files, new GitDiffClient(f.git)),
	);
	await resumedWs.recover();
	const resumed = new PullRequestService(
		resumedStore,
		new PullRequestClient(resumedWs, f.git, new GitDiffClient(f.git)),
		f.access,
		randomUUID,
		() => new Date(),
	);
	expect((await resumed.get(owner, pr.id)).discussion).toHaveLength(3);
	expect((await resumed.get(owner, pr.id)).approval).toBe("requested-changes");
	await resumedWs.archive(owner, f.workspace.id);
	expect(await resumed.get(owner, pr.id)).toMatchObject({ approval: "unavailable", discussion: expect.any(Array) });
	expect((await resumed.get(owner, pr.id)).discussion).toHaveLength(3);
}, 30_000);

test("SQLite PR store enforces foreign keys, immutable source and bounded discussion while translating corrupt rows", async () => {
	const f = await setup();
	const record = {
		id: randomUUID(),
		projectId: f.project.id,
		workspaceId: f.workspace.id,
		branch: f.workspace.branch,
		base: "main" as const,
		title: "Persisted",
		body: "",
		status: "open" as const,
		createdAt: new Date().toISOString(),
	};
	await expect(f.store.insert({ ...record, workspaceId: randomUUID() })).rejects.toMatchObject({
		code: "pull-request-unavailable",
	});
	await f.store.insert(record);
	await expect(f.store.update({ ...record, branch: `forge/workspace/${randomUUID()}` })).rejects.toMatchObject({
		code: "pull-request-unavailable",
	});
	const revision = (await f.service.preview(owner, f.workspace.id)).revision;
	for (let index = 0; index < 1000; index++)
		await f.store.append({
			id: randomUUID(),
			pullRequestId: record.id,
			kind: "comment",
			body: `entry ${index}`,
			revision,
			createdAt: record.createdAt,
		});
	await expect(
		f.store.append({
			id: randomUUID(),
			pullRequestId: record.id,
			kind: "approve",
			body: "over limit",
			revision,
			createdAt: record.createdAt,
		}),
	).rejects.toMatchObject({ code: "pull-request-unavailable" });
	const discussion = await f.store.discussion(record.id);
	expect(discussion).toHaveLength(1000);
	expect(discussion.at(0)?.body).toBe("entry 0");
	expect(discussion.at(-1)?.body).toBe("entry 999");
	await f.db.run("UPDATE pull_requests SET title = '' WHERE id = ?", [record.id]);
	await expect(f.store.get(record.id)).rejects.toMatchObject({
		code: "pull-request-unavailable",
		message: "pull-request-unavailable",
	});
}, 30_000);
