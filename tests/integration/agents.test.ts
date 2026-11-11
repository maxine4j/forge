import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test, vi } from "vitest";

import { AccountProcess } from "../../src/accounts/account-process.ts";
import { CodexConnection } from "../../src/accounts/codex-connection.ts";
import { AgentExecutionPool } from "../../src/agents/agent-execution-pool.ts";
import { AgentService } from "../../src/agents/agent-service.ts";
import { AgentThreadStore } from "../../src/agents/agent-thread-store.ts";
import { AccessService } from "../../src/auth/access-service.ts";
import { CodexAgentClient } from "../../src/codex/codex-agent-client.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { ProjectService } from "../../src/projects/project-service.ts";
import { ProjectStore } from "../../src/projects/project-store.ts";
import { GitDiffClient } from "../../src/repositories/git-diff-client.ts";
import { GitTransport } from "../../src/repositories/git-transport.ts";
import { RepositoryClient } from "../../src/repositories/repository-client.ts";
import { WorkspaceClient } from "../../src/workspaces/workspace-client.ts";
import { WorkspaceDiffClient } from "../../src/workspaces/workspace-diff-client.ts";
import { WorkspaceService } from "../../src/workspaces/workspace-service.ts";
import { WorkspaceStore } from "../../src/workspaces/workspace-store.ts";

test("real Git/SQLite and a stdio peer run concurrent agents only in owned worktrees and retain interrupted intent", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-agent-integration-"));
	const db = new SqliteDatabase(join(root, "forge.sqlite"));
	const git = new GitTransport();
	const executable = join(root, "agent-peer");
	await files.writeFile(
		executable,
		`#!${process.execPath}\n${await files.readFile(fileURLToPath(new URL("../fixtures/agent-peer.mjs", import.meta.url)))}`,
		{ mode: 0o700 },
	);
	const connection = new CodexConnection(
		new AccountProcess(
			{
				dataDirectory: root,
				path: process.env["PATH"] ?? "",
				codexExecutable: executable,
				githubExecutable: "gh",
			},
			sleep,
		),
		sleep,
	);
	let agents: AgentService | undefined;
	try {
		await db.initialize();
		const access = new AccessService({ owner: "owner", origin: "https://forge.example" });
		const owner = { username: "owner" };
		const projectStore = new ProjectStore(db);
		await projectStore.initialize();
		const repositories = new RepositoryClient(root, [], files, git);
		const projects = new ProjectService(projectStore, repositories, access, randomUUID, () => new Date());
		const project = await projects.create(owner, { name: "Project" });
		const workspaceStore = new WorkspaceStore(db);
		await workspaceStore.initialize();
		const workspaceClient = new WorkspaceClient(root, files, git, repositories);
		const workspaces = new WorkspaceService(
			workspaceStore,
			workspaceClient,
			projects,
			access,
			randomUUID,
			() => new Date(),
			new WorkspaceDiffClient(workspaceClient, git, files, new GitDiffClient(git)),
		);
		const store = new AgentThreadStore(db);
		await store.initialize();
		agents = new AgentService(
			store,
			new CodexAgentClient(connection, files.realpath, randomUUID),
			workspaces,
			projects,
			access,
			randomUUID,
			() => new Date(),
			new AgentExecutionPool(),
		);
		const one = await agents.create(owner, project.id, "One");
		const two = await agents.create(owner, project.id, "Two");
		const paths = await Promise.all(
			[one, two].map(async (view) => {
				const { path, workspace } = await workspaces.resolve(owner, view.thread.workspaceId);
				expect(await git.run(["-C", path, "symbolic-ref", "--short", "HEAD"])).toBe(`${workspace.branch}\n`);
				expect(await git.run(["-C", path, "rev-parse", "--is-inside-work-tree"])).toBe("true\n");
				return path;
			}),
		);
		expect(paths[0]).not.toBe(paths[1]);
		await files.writeFile(join(paths[0]!, "README.md"), "# Project\n");
		expect(await agents.files(owner, one.thread.id, "")).toContain("README.md");
		await Promise.all([agents.send(owner, one.thread.id, "First"), agents.send(owner, two.thread.id, "Second")]);
		expect((await agents.get(owner, one.thread.id)).thread.status).toBe("running");
		expect((await agents.get(owner, two.thread.id)).items).toEqual(
			expect.arrayContaining([expect.objectContaining({ text: "Working" })]),
		);
		const managed = await agents.createTicketThread(owner, project.id, "Ticket implementation");
		const running = await agents.dispatch(owner, managed.thread.id, "Keep working", {
			ticketId: "FORGE-1",
			phase: "implementation",
		});
		const turnId = running.thread.turnId!;
		await expect(agents.steer(owner, managed.thread.id, "stale", "Feedback")).rejects.toThrow("agent-conflict");
		await agents.steer(owner, managed.thread.id, turnId, "Focus on tests");
		await expect
			.poll(async () =>
				(await agents!.get(owner, managed.thread.id)).items.some((item) => item.text === "Focus on tests"),
			)
			.toBe(true);
		expect((await agents.get(owner, managed.thread.id)).thread.turnId).toBe(turnId);
		await agents.interrupt(owner, managed.thread.id);
		await expect(agents.steer(owner, managed.thread.id, turnId, "Too late")).rejects.toThrow("agent-conflict");
		const restored = await agents.resume(owner, managed.thread.id);
		expect(restored.items).toEqual(
			expect.arrayContaining([expect.objectContaining({ role: "user", text: "Focus on tests" })]),
		);
		await agents.interrupt(owner, one.thread.id);
		expect((await agents.get(owner, one.thread.id)).thread.status).toBe("interrupted");
		await agents.shutdown();
		await store.recover();
		expect((await store.get(two.thread.id))?.status).toBe("uncertain");
		const missingId = randomUUID();
		await store.insert({
			...(await store.get(two.thread.id))!,
			id: missingId,
			codexId: randomUUID(),
			turnId: undefined,
		});
		let recoveredPool = new AgentExecutionPool();
		const restart = async () => {
			await agents!.shutdown();
			await store.recover();
			recoveredPool = new AgentExecutionPool();
			agents = new AgentService(
				store,
				new CodexAgentClient(connection, files.realpath, randomUUID),
				workspaces,
				projects,
				access,
				randomUUID,
				() => new Date(),
				recoveredPool,
			);
			await agents.seed(owner);
			await agents.recover(owner);
		};
		await restart();
		expect((await store.get(missingId))?.status).toBe("interrupted");
		expect(recoveredPool.activeIds()).toEqual([two.thread.id]);
		expect(await agents.stopAll(owner)).toEqual({ requested: 1, recovered: 1, failed: 0 });
		expect((await store.get(two.thread.id))?.status).toBe("interrupted");
		await restart();
		expect(recoveredPool.activeIds()).toEqual([]);
		expect((await store.get(two.thread.id))?.status).toBe("interrupted");
		expect(await files.readFile(join(paths[0]!, ".git"))).toContain("gitdir:");
	} finally {
		await agents?.shutdown();
		await connection.close();
		await git.close();
		await db.close();
		await files.rm(root, { recursive: true, force: true });
	}
});

test("pinned Codex starts and resumes a Plan mode turn without an inner sandbox or live credentials", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-agent-protocol-"));
	const path = join(root, "worktrees", "probe");
	await files.mkdir(path, { recursive: true });
	const git = new GitTransport();
	const connection = new CodexConnection(
		new AccountProcess(
			{
				dataDirectory: root,
				path: process.env["PATH"] ?? "",
				codexExecutable: fileURLToPath(new URL("../../node_modules/.bin/codex", import.meta.url)),
				githubExecutable: "gh",
			},
			sleep,
		),
		sleep,
	);
	try {
		await git.run(["init", "--bare", join(root, "repository.git")]);
		const tree = (
			await git.run(["-C", join(root, "repository.git"), "hash-object", "-w", "-t", "tree", "/dev/null"])
		).trim();
		const commit = (
			await git.run([
				"-C",
				join(root, "repository.git"),
				"-c",
				"user.name=Probe",
				"-c",
				"user.email=probe@example.test",
				"commit-tree",
				tree,
				"-m",
				"Initial",
			])
		).trim();
		await git.run(["-C", join(root, "repository.git"), "worktree", "add", "-b", "probe", path, commit]);
		const client = new CodexAgentClient(connection, files.realpath, randomUUID);
		await files.writeFile(join(path, "probe.ts"), "export const probe = true;\n");
		expect((await client.options(path)).models.length).toBeGreaterThan(0);
		expect(await client.reconcile()).toEqual({ state: "inactive" });
		expect(await new CodexAgentClient(connection, files.realpath, randomUUID).reconcile()).toEqual({
			state: "unavailable",
		});
		expect(await client.files(path, "probe")).toContain("probe.ts");
		const rpc = vi.spyOn(connection, "request");
		const id = await client.start(path);
		await expect(rpc.mock.results.at(-1)!.value).resolves.toMatchObject({
			sandbox: { type: "dangerFullAccess" },
			approvalPolicy: "on-request",
		});
		expect(client.read(id).status).toBe("idle");
		const result = await connection.request("thread/read", { threadId: id, includeTurns: false });
		expect(result).toMatchObject({ thread: { id, cwd: await files.realpath(path) } });
		await client.send(
			id,
			path,
			"Protocol probe with no credentials",
			{ permissions: "approve-for-me" },
			{
				projectId: "probe",
				ticketId: "FORGE-1",
				phase: "planning",
			},
		);
		await expect.poll(() => client.read(id).items.length).toBeGreaterThan(0);
		await client.interrupt(id, client.read(id).turnId!);
		await expect.poll(() => client.read(id).status).toBe("interrupted");
		expect(await client.resume(id, path)).toMatchObject({ status: "interrupted" });
		expect(client.read(id).items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ role: "user", text: "Protocol probe with no credentials" }),
			]),
		);
		expect(rpc).toHaveBeenCalledWith("thread/turns/list", {
			threadId: id,
			limit: 20,
			sortDirection: "desc",
			itemsView: "notLoaded",
		});
		expect(rpc).toHaveBeenCalledWith("thread/items/list", {
			threadId: id,
			limit: 20,
			sortDirection: "desc",
		});
		const resumeIndex = rpc.mock.calls.findIndex(([method]) => method === "thread/resume");
		await expect(rpc.mock.results.at(resumeIndex)!.value).resolves.toMatchObject({
			sandbox: { type: "dangerFullAccess" },
			approvalPolicy: "on-request",
		});
		expect(await client.reconcile(id, path)).toEqual({ state: "inactive" });
		expect(await client.reconcile(randomUUID(), path)).toEqual({ state: "missing" });
	} finally {
		await connection.close();
		await git.close();
		await files.rm(root, { recursive: true, force: true });
	}
});
