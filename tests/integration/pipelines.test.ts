import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { afterEach, expect, test, vi } from "vitest";

import { AccessService } from "../../src/auth/access-service.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { HttpApplication } from "../../src/http/http-application.ts";
import { GitSnapshotClient } from "../../src/pipelines/git-snapshot-client.ts";
import { PipelineRouter } from "../../src/pipelines/pipeline-router.ts";
import { PipelineService } from "../../src/pipelines/pipeline-service.ts";
import { PipelineStore } from "../../src/pipelines/pipeline-store.ts";
import { ProjectRouter } from "../../src/projects/project-router.ts";
import { ProjectService } from "../../src/projects/project-service.ts";
import { ProjectStore } from "../../src/projects/project-store.ts";
import { GitTransport } from "../../src/repositories/git-transport.ts";
import { RepositoryClient } from "../../src/repositories/repository-client.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});
const owner = { username: "owner" };
async function setup() {
	const root = await files.mkdtemp(join(tmpdir(), "forge-pipelines-"));
	cleanup.push(() => files.rm(root, { recursive: true, force: true }));
	const db = new SqliteDatabase(join(root, "forge.sqlite"));
	await db.initialize();
	cleanup.push(() => db.close());
	const git = new GitTransport(sleep, { identity: () => ({ name: "Test", email: "test@example.test" }) });
	cleanup.push(() => git.close());
	const access = new AccessService({ owner: "owner", origin: "https://forge.example" });
	const repositories = new RepositoryClient(root, [], files, git);
	const projectsStore = new ProjectStore(db);
	await projectsStore.initialize();
	const projects = new ProjectService(projectsStore, repositories, access, randomUUID, () => new Date());
	const project = await projects.create(owner, { name: "Pipelines" });
	const repository = join(root, "repositories", `${project.id}.git`);
	const authoring = join(root, "authoring");
	await git.run(["init", "--initial-branch=main", authoring]);
	await files.mkdir(join(authoring, ".github/workflows"), { recursive: true });
	await files.writeFile(
		join(authoring, ".github/workflows/ci.yaml"),
		"name: CI\non: [push, workflow_dispatch]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: [{run: cat source.txt}]\n",
	);
	await files.writeFile(join(authoring, "source.txt"), "original");
	await git.run(["-C", authoring, "add", "."]);
	await git.run(["-C", authoring, "commit", "-m", "original"]);
	await git.run(["-C", repository, "-c", "protocol.file.allow=always", "fetch", authoring, "main:main"]);
	const snapshots = new GitSnapshotClient(root, git, files, repositories);
	const store = new PipelineStore(db);
	await store.initialize();
	return { root, git, db, projects, project, repository, authoring, snapshots, store, access };
}
test("snapshot workflow and source remain pinned despite branch movement; cleanup preserves repository and credentials", async () => {
	const { root, git, db, project, repository, authoring, snapshots, store } = await setup();
	const discovered = await snapshots.discover(project.id, "main");
	expect(discovered.workflows[0]?.events).toEqual(["push", "workflow_dispatch"]);
	await files.writeFile(join(authoring, "source.txt"), "moved");
	await files.writeFile(join(authoring, ".github/workflows/ci.yaml"), "invalid: moved");
	await git.run(["-C", authoring, "commit", "--amend", "-am", "moved"]);
	await git.run(["-C", repository, "-c", "protocol.file.allow=always", "fetch", authoring, "+main:main"]);
	const id = randomUUID();
	const input = { branch: "main", workflowPath: ".github/workflows/ci.yaml", event: "push" };
	const execution = await snapshots.create(id, project.id, discovered.commit, input, discovered.workflows[0]!);
	expect(await files.readFile(join(execution.source, "source.txt"))).toBe("original");
	expect(await files.readFile(join(execution.source, input.workflowPath))).toContain("name: CI");
	expect((await git.run(["-C", execution.source, "rev-parse", "HEAD"])).trim()).toBe(discovered.commit);
	await files.mkdir(join(root, "github"));
	await files.writeFile(join(root, "github/credential"), "keep");
	const run = {
		...input,
		id,
		projectId: project.id,
		commit: discovered.commit,
		workflowName: "CI",
		state: "running" as const,
		createdAt: new Date().toISOString(),
		startedAt: null,
		finishedAt: null,
		failure: null,
		jobs: discovered.workflows[0]!.jobs,
	};
	await store.save(run);
	expect(await new PipelineStore(db).list(project.id, 0)).toEqual([run]);
	expect(await store.get(id)).toEqual(run);
	await snapshots.remove(id);
	expect(await files.readFile(join(root, "github/credential"))).toBe("keep");
	expect(await git.run(["-C", repository, "show", "main:source.txt"])).toBe("moved");
	expect(await files.readFile(join(authoring, "source.txt"))).toBe("moved");
});
test("owner HTTP, origin, project scoping, durable execution and restart recovery", async () => {
	const { projects, project, store, snapshots, access } = await setup();
	let finish!: (code: number) => void;
	const pending = new Promise<number>((resolve) => {
		finish = resolve;
	});
	const process = {
		available: async () => {},
		run: vi.fn(async () => pending),
		cleanup: vi.fn().mockResolvedValue(undefined),
	};
	const service = new PipelineService(projects, store, snapshots, process, randomUUID, () => new Date(), sleep);
	cleanup.push(() => service.shutdown());
	const server = createServer(
		new HttpApplication(new ProjectRouter(projects), access).create([new PipelineRouter(service)]).callback(),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	cleanup.push(
		() =>
			new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	);
	const address = server.address();
	if (!address || typeof address === "string") throw new Error();
	const base = `http://127.0.0.1:${address.port}/api/projects/${project.id}`;
	const headers = { "x-webauth-user": "owner", origin: "https://forge.example", "content-type": "application/json" };
	const body = JSON.stringify({ branch: "main", workflowPath: ".github/workflows/ci.yaml", event: "push" });
	expect((await fetch(`${base}/pipelines`)).status).toBe(403);
	expect(
		(
			await fetch(`${base}/pipeline-runs`, {
				method: "POST",
				headers: { ...headers, origin: "https://other.example" },
				body,
			})
		).status,
	).toBe(403);
	const submitted = await fetch(`${base}/pipeline-runs`, { method: "POST", headers, body });
	expect(submitted.status).toBe(202);
	const run = (await submitted.json()) as { id: string };
	const other = await projects.create(owner, { name: "Other project" });
	expect((await fetch(`${base.replace(project.id, other.id)}/pipeline-runs/${run.id}`, { headers })).status).toBe(
		404,
	);
	expect((await fetch(`${base}/pipeline-runs`, { method: "POST", headers, body })).status).toBe(409);
	await vi.waitFor(() => expect(process.run).toHaveBeenCalled());
	finish(1);
	await vi.waitFor(async () => expect((await store.get(run.id))?.state).toBe("failed"));
	const result = await fetch(`${base}/pipeline-runs/${run.id}`, { headers });
	expect(result.status).toBe(200);
	expect(((await result.json()) as { failure: string }).failure).toContain("code 1");
	const record = (await store.get(run.id))!;
	record.state = "running";
	await store.save(record);
	await service.recover();
	expect((await store.get(run.id))?.state).toBe("interrupted");
	expect(process.run).toHaveBeenCalledTimes(1);
});
