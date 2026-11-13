import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import type { AgentOptions } from "@forge/contracts/agents";
import { expect, test, vi } from "vitest";

import { AccountProcess } from "../../src/accounts/account-process.ts";
import { CodexConnection } from "../../src/accounts/codex-connection.ts";
import { AgentExecutionPool } from "../../src/agents/agent-execution-pool.ts";
import { AgentService } from "../../src/agents/agent-service.ts";
import { AgentThreadStore } from "../../src/agents/agent-thread-store.ts";
import { AccessService } from "../../src/auth/access-service.ts";
import { CodexAgentClient } from "../../src/codex/codex-agent-client.ts";
import { CodexUsageClient } from "../../src/codex/codex-usage-client.ts";
import { CostService } from "../../src/cost/cost-service.ts";
import { CostStore } from "../../src/cost/cost-store.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { EpicStore } from "../../src/epics/epic-store.ts";
import { ProjectService } from "../../src/projects/project-service.ts";
import { ProjectStore } from "../../src/projects/project-store.ts";
import { GitDiffClient } from "../../src/repositories/git-diff-client.ts";
import { GitTransport } from "../../src/repositories/git-transport.ts";
import { RepositoryClient } from "../../src/repositories/repository-client.ts";
import { TicketPrompts } from "../../src/tickets/ticket-prompts.ts";
import { TicketService } from "../../src/tickets/ticket-service.ts";
import { TicketStore } from "../../src/tickets/ticket-store.ts";
import { TicketWorkflowService } from "../../src/tickets/ticket-workflow-service.ts";
import { TicketWorkflowStore } from "../../src/tickets/ticket-workflow-store.ts";
import { WorkspaceClient } from "../../src/workspaces/workspace-client.ts";
import { WorkspaceDiffClient } from "../../src/workspaces/workspace-diff-client.ts";
import { WorkspaceMergeClient } from "../../src/workspaces/workspace-merge-client.ts";
import { WorkspaceService } from "../../src/workspaces/workspace-service.ts";
import { WorkspaceStore } from "../../src/workspaces/workspace-store.ts";

test("real Git, SQLite and controlled app-server execute the ticket lifecycle and recover a committed merge", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-workflow-"));
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
	let usage: CodexUsageClient | undefined;
	try {
		await db.initialize();
		const access = new AccessService({ owner: "owner", origin: "https://forge.example" });
		const owner = { username: "owner" };
		const projectsStore = new ProjectStore(db);
		await projectsStore.initialize();
		const repositories = new RepositoryClient(root, [], files, git);
		const projects = new ProjectService(projectsStore, repositories, access, randomUUID, () => new Date());
		const project = await projects.create(owner, { name: "Project" });
		const other = await projects.create(owner, { name: "Other" });
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
		const agentStore = new AgentThreadStore(db);
		await agentStore.initialize();
		let pool = new AgentExecutionPool();
		const costStore = new CostStore(db);
		await costStore.initialize(new Date().toISOString());
		usage = new CodexUsageClient(
			connection,
			(turn) => costStore.save(turn),
			() => new Date(),
			async () => ({ localCurrency: "AUD", monthlyPlanLocal: 30, usdToLocal: 1.44 }),
			async () => {},
		);
		const client = new CodexAgentClient(connection, files.realpath, randomUUID, usage);
		const rpc = vi.spyOn(connection, "request");
		let defaults: Pick<AgentOptions, "defaultModel" | "defaultReasoningEffort"> = {};
		const readDefaults = () => defaults;
		agents = new AgentService(
			agentStore,
			client,
			workspaces,
			projects,
			access,
			randomUUID,
			() => new Date(),
			pool,
			readDefaults,
		);
		const ticketStore = new TicketStore(db);
		await ticketStore.initialize();
		const cost = new CostService(access, ticketStore, costStore, usage, () => new Date());
		const jobs = new TicketWorkflowStore(db);
		await jobs.initialize();
		const merges = new WorkspaceMergeClient(workspaces, git);
		let dispatch: "running" | "paused" | "stopped" = "running";
		const workflowService = (service: AgentService) =>
			new TicketWorkflowService(
				jobs,
				ticketStore,
				service,
				pool,
				merges,
				workspaces,
				new TicketPrompts(),
				access,
				undefined,
				() => dispatch,
				workspaces,
			);
		let workflow = workflowService(agents);
		let tickets = new TicketService(
			ticketStore,
			projectsStore,
			access,
			() => new Date(),
			workflow,
			new EpicStore(db),
		);
		const restart = async () => {
			await agents!.shutdown();
			await agentStore.recover();
			await jobs.initialize();
			pool = new AgentExecutionPool();
			agents = new AgentService(
				agentStore,
				new CodexAgentClient(connection, files.realpath, randomUUID, usage),
				workspaces,
				projects,
				access,
				randomUUID,
				() => new Date(),
				pool,
				readDefaults,
			);
			await agents.seed(owner);
			await agents.recover(owner);
			workflow = workflowService(agents);
			tickets = new TicketService(
				ticketStore,
				projectsStore,
				access,
				() => new Date(),
				workflow,
				new EpicStore(db),
			);
			await workflow.recover(owner);
		};
		const ticket = await tickets.create(owner, {
			repositoryIds: [project.id, other.id],
			title: "Implement search",
			description: "Find files",
		});
		const standalone = await Promise.all([1, 2, 3].map((n) => agents!.create(owner, other.id, `Standalone ${n}`)));
		for (const view of standalone) await agents.send(owner, view.thread.id, "Keep working");
		await tickets.move(owner, ticket.id, { status: "todo" });
		await workflow.tick(owner);
		expect((await jobs.get(ticket.id))?.plannerId).toBeUndefined();
		expect((await tickets.list(owner)).at(0)?.agentStatus).toBe("queued");
		await agents.interrupt(owner, standalone[0]!.thread.id);
		dispatch = "paused";
		await workflow.tick(owner);
		expect((await ticketStore.get(ticket.id))?.status).toBe("todo");
		expect((await jobs.get(ticket.id))?.plannerId).toBeUndefined();
		dispatch = "running";
		const resolve = workspaces.resolve.bind(workspaces);
		expect((await tickets.list(owner)).at(0)?.agentStatus).toBe("queued");
		vi.spyOn(workspaces, "resolve").mockImplementationOnce(async (...args) => {
			dispatch = "paused";
			return resolve(...args);
		});
		await workflow.tick(owner);
		const preparedPlanner = (await jobs.get(ticket.id))?.plannerId;
		expect(preparedPlanner).toBeDefined();
		expect((await jobs.get(ticket.id))?.executionRepositoryId).toBe(project.id);
		expect((await workspaces.get(owner, (await jobs.get(ticket.id))!.workspaceId!)).projectId).toBe(project.id);
		expect((await ticketStore.get(ticket.id))?.status).toBe("todo");
		await restart();
		expect((await ticketStore.get(ticket.id))?.repositoryIds).toEqual([project.id, other.id]);
		expect((await jobs.get(ticket.id))?.executionRepositoryId).toBe(project.id);
		await workflow.tick(owner);
		expect((await ticketStore.get(ticket.id))?.status).toBe("todo");
		expect((await jobs.get(ticket.id))?.state).toBe("queued");
		dispatch = "running";
		await workflow.settings(owner, (await ticketStore.get(ticket.id))!, { reasoningEffort: "medium" });
		defaults = { defaultModel: "gpt-5.4-mini", defaultReasoningEffort: "low" };
		await workflow.tick(owner);
		expect((await jobs.get(ticket.id))?.state).toBe("setup-failed");
		expect(pool.activeIds()).not.toContain(preparedPlanner);
		await workflow.settings(owner, (await ticketStore.get(ticket.id))!, {});
		defaults = { defaultModel: "gpt-5.4", defaultReasoningEffort: "high" };
		await workflow.recover(owner, ticket.id);
		await workflow.tick(owner);
		const planning = (await jobs.get(ticket.id))!;
		expect(planning.plannerId).toBe(preparedPlanner);
		dispatch = "paused";
		const idle = async () => {
			await workflow.tick(owner);
			return (await jobs.get(ticket.id))?.state;
		};
		await expect.poll(idle).toBe("idle");
		expect((await jobs.get(ticket.id))?.plan?.revision).toBe(1);
		expect(rpc).toHaveBeenCalledWith(
			"turn/start",
			expect.objectContaining({
				model: "gpt-5.4",
				effort: "high",
				collaborationMode: {
					mode: "plan",
					settings: { model: "gpt-5.4", reasoning_effort: "high", developer_instructions: null },
				},
			}),
		);
		defaults = { defaultModel: "gpt-5.4", defaultReasoningEffort: "medium" };
		await workflow.message(owner, (await ticketStore.get(ticket.id))!, "Include filtering");
		dispatch = "stopped";
		await workflow.tick(owner);
		expect((await jobs.get(ticket.id))?.state).toBe("queued");
		dispatch = "paused";
		await workflow.tick(owner);
		await expect.poll(idle).toBe("idle");
		expect((await jobs.get(ticket.id))?.plan?.revision).toBe(2);
		expect(rpc.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1]).toMatchObject({
			model: "gpt-5.4",
			effort: "medium",
			collaborationMode: { settings: { model: "gpt-5.4", reasoning_effort: "medium" } },
		});
		dispatch = "running";
		expect((await tickets.list(owner)).at(0)).toMatchObject({
			status: "in-progress",
			needsAttention: true,
		});
		const { path } = await workspaces.resolve(owner, planning.workspaceId!);
		const main = (await git.run(["-C", path, "rev-parse", "main"])).trim();
		const tree = (await git.run(["-C", path, "rev-parse", "main^{tree}"])).trim();
		const advanced = (
			await git.run(
				[
					"-C",
					path,
					"-c",
					"user.name=Owner",
					"-c",
					"user.email=owner@example.com",
					"commit-tree",
					tree,
					"-p",
					main,
				],
				"Concurrent main work\n",
			)
		).trim();
		await git.run(["-C", path, "update-ref", "refs/heads/main", advanced, main]);
		await workflow.approve(owner, (await ticketStore.get(ticket.id))!, 2);
		expect((await tickets.list(owner)).at(0)).toMatchObject({ agentStatus: "queued" });
		expect((await tickets.list(owner)).at(0)?.needsAttention).toBeUndefined();
		await restart();
		await workflow.tick(owner);
		await expect.poll(idle).toBe("merge-queued");
		expect((await tickets.list(owner)).at(0)?.agentStatus).toBeUndefined();
		const implemented = (await jobs.get(ticket.id))!;
		expect(implemented.workspaceId).toBe(planning.workspaceId);
		expect(implemented.implementerId).not.toBe(planning.plannerId);
		await workflow.tick(owner);
		expect(await jobs.get(ticket.id)).toMatchObject({ state: "queued", phase: "rebase", mergeAttempts: 1 });
		await workflow.tick(owner);
		// Lose Forge's in-memory history after the noisy rebase finishes, before observing its result.
		await expect
			.poll(async () => (await agents!.get(owner, implemented.implementerId!)).thread.status)
			.toBe("completed");
		await jobs.save({ ...(await jobs.get(ticket.id))!, state: "uncertain" });
		await restart();
		expect((await agents!.get(owner, implemented.implementerId!)).truncated).toBe(true);
		const completed = (await jobs.get(ticket.id))!;
		// Reconstruct services from persisted intent at the Git/SQLite crash boundary.
		expect(completed.state).toBe("merge-queued");
		expect(await merges.isMerged(owner, planning.workspaceId!, completed.resultSha!)).toBe(false);
		await expect(merges.merge(owner, planning.workspaceId!, completed.resultSha!)).resolves.toBe("merged");
		expect(await merges.isMerged(owner, planning.workspaceId!, completed.resultSha!)).toBe(true);
		const localFile = join(path, "local-notes.txt");
		await files.writeFile(localFile, "Uncommitted notes");
		await expect(workspaces.cleanupMerged(owner, planning.workspaceId!, completed.resultSha!)).rejects.toThrow(
			"workspace-unavailable",
		);
		expect(await files.readFile(localFile)).toBe("Uncommitted notes");
		await files.rm(localFile);
		const branch = `refs/heads/forge/workspace/${planning.workspaceId}`;
		await git.run([
			"-C",
			path,
			"-c",
			"user.name=Owner",
			"-c",
			"user.email=owner@example.com",
			"commit",
			"--allow-empty",
			"-m",
			"Work after merge",
		]);
		const later = (await git.run(["-C", path, "rev-parse", "HEAD"])).trim();
		await expect(workspaces.cleanupMerged(owner, planning.workspaceId!, completed.resultSha!)).rejects.toThrow(
			"workspace-unavailable",
		);
		expect((await git.run(["-C", path, "rev-parse", branch])).trim()).toBe(later);
		await git.run(["-C", path, "update-ref", branch, completed.resultSha!, later]);
		await restart();
		await workflow.tick(owner);
		expect((await ticketStore.get(ticket.id))?.status).toBe("done");
		expect((await jobs.get(ticket.id))?.resultSha).toBe(completed.resultSha);
		const repository = join(root, "repositories", `${project.id}.git`);
		expect((await git.run(["-C", repository, "rev-parse", "main"])).trim()).toBe(completed.resultSha);
		expect(await git.run(["-C", repository, "branch", "--list", `forge/workspace/${planning.workspaceId}`])).toBe(
			"",
		);
		await expect(files.lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await workspaces.get(owner, planning.workspaceId!)).toMatchObject({ status: "archived" });
		await restart();
		const history = await agents!.resume(owner, implemented.implementerId!);
		expect(history.thread.status).toBe("completed");
		expect(history.items.some((item) => item.role === "assistant")).toBe(true);
		expect(history.contextWindow).toEqual({ used: 1100, max: 128000 });
		expect(await agents!.list(owner, project.id)).toEqual([]);
		const archived = await tickets.archive(owner, ticket.id);
		await expect.poll(async () => (await cost.read(owner)).totals.input).toBe(7000);
		const recorded = await cost.read(owner);
		expect(recorded.phases.filter(({ turns }) => turns).map(({ phase, turns }) => [phase, turns])).toEqual([
			["planning", 2],
			["implementation", 1],
			["rebase", 1],
			["chat", 3],
		]);
		expect(recorded.tickets.at(0)).toMatchObject({
			id: ticket.id,
			archivedAt: archived.archivedAt,
			cached: 2000,
			incomplete: { api: 0 },
		});
		expect(recorded.tickets.at(0)?.apiUsd).toBeCloseTo(0.0115);
		expect(recorded.limits?.windows.at(0)).toMatchObject({ minutes: 300, usedPercent: 40 });
		expect((await cost.read(owner)).phases.map(({ phase }) => phase)).toContain("chat");

		const returning = await tickets.create(owner, {
			repositoryIds: [project.id],
			title: "Restart cleanly",
			description: "Current scope",
		});
		await tickets.move(owner, returning.id, { status: "todo" });
		await workflow.tick(owner);
		await expect
			.poll(async () => {
				await workflow.tick(owner);
				return (await jobs.get(returning.id))?.plan?.revision;
			})
			.toBe(1);
		const old = (await jobs.get(returning.id))!;
		const oldPath = (await workspaces.resolve(owner, old.workspaceId!)).path;
		await files.writeFile(join(oldPath, "dirty-notes.txt"), "Discard on return");
		await expect
			.poll(async () => (await cost.read(owner)).tickets.find(({ id }) => id === returning.id)?.turns)
			.toBe(1);
		const beforeReturn = (await cost.read(owner)).tickets.find(({ id }) => id === returning.id)!;
		await tickets.move(owner, returning.id, { status: "backlog" });
		await workflow.recover(owner, returning.id);
		expect(await jobs.get(returning.id)).toMatchObject({ state: "idle", plan: old.plan });
		await expect(files.lstat(oldPath)).rejects.toMatchObject({ code: "ENOENT" });
		expect((await workspaces.get(owner, old.workspaceId!)).status).toBe("archived");
		await restart();
		expect((await jobs.get(returning.id))?.plan).toEqual(old.plan);
		expect((await cost.read(owner)).tickets.find(({ id }) => id === returning.id)).toEqual(beforeReturn);
		const calls = rpc.mock.calls.filter(([method]) => method === "turn/start").length;
		await tickets.move(owner, returning.id, { status: "todo" });
		await workflow.tick(owner);
		const fresh = (await jobs.get(returning.id))!;
		expect(fresh).toMatchObject({ phase: "implementation", state: "running", approvedRevision: 1 });
		expect(fresh.workspaceId).not.toBe(old.workspaceId);
		expect(fresh.implementerId).not.toBe(old.plannerId);
		expect(fresh.baseSha).toBe(completed.resultSha);
		expect(rpc.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(calls + 1);
		await tickets.move(owner, returning.id, { status: "backlog" });
		await workflow.recover(owner, returning.id);
		const usageBeforeClear = (await cost.read(owner)).tickets.find(({ id }) => id === returning.id);
		await workflow.clearPlan(owner, (await ticketStore.get(returning.id))!);
		expect((await jobs.get(returning.id))?.plan).toBeUndefined();
		expect((await cost.read(owner)).tickets.find(({ id }) => id === returning.id)).toEqual(usageBeforeClear);
		const prepare = workspaceClient.prepare.bind(workspaceClient);
		for (const stage of ["before", "after"] as const) {
			const failedTicket = await tickets.create(owner, {
				repositoryIds: [project.id],
				title: `Setup failure ${stage}`,
				description: "",
			});
			vi.spyOn(workspaceClient, "prepare").mockImplementationOnce(async (record) => {
				if (stage === "after") await prepare(record);
				throw new Error("Preparation failed");
			});
			await tickets.move(owner, failedTicket.id, { status: "todo" });
			await workflow.tick(owner);
			const failedJob = (await jobs.get(failedTicket.id))!;
			expect(failedJob).toMatchObject({ state: "setup-failed", workspaceId: expect.any(String) });
			expect(failedJob.plannerId).toBeUndefined();
			await tickets.move(owner, failedTicket.id, { status: "backlog" });
			await workflow.recover(owner, failedTicket.id);
			expect((await jobs.get(failedTicket.id))?.state).toBe("idle");
			expect((await workspaces.get(owner, failedJob.workspaceId!)).status).toBe("archived");
			await expect(files.lstat(join(root, "worktrees", failedJob.workspaceId!))).rejects.toMatchObject({
				code: "ENOENT",
			});
		}
	} finally {
		await agents?.shutdown();
		await usage?.close();
		await connection.close();
		await git.close();
		await db.close();
		await files.rm(root, { recursive: true, force: true });
	}
}, 30_000);
