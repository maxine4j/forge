import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test } from "vitest";

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
			30,
		);
		const client = new CodexAgentClient(connection, files.realpath, randomUUID, usage);
		agents = new AgentService(agentStore, client, workspaces, projects, access, randomUUID, () => new Date(), pool);
		const ticketStore = new TicketStore(db);
		await ticketStore.initialize();
		const cost = new CostService(
			projects,
			ticketStore,
			costStore,
			usage,
			{ monthlyAud: 30, audPerUsd: 1.44, exchangeDate: "2026-11-10" },
			() => new Date(),
		);
		const jobs = new TicketWorkflowStore(db);
		await jobs.initialize();
		const merges = new WorkspaceMergeClient(workspaces, git);
		let workflow = new TicketWorkflowService(jobs, ticketStore, agents, pool, merges, new TicketPrompts(), access);
		let tickets = new TicketService(ticketStore, projectsStore, access, () => new Date(), workflow);
		const restart = async () => {
			await agents!.shutdown();
			await agentStore.recover();
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
			);
			await agents.seed(owner);
			await agents.recover(owner);
			workflow = new TicketWorkflowService(jobs, ticketStore, agents, pool, merges, new TicketPrompts(), access);
			tickets = new TicketService(ticketStore, projectsStore, access, () => new Date(), workflow);
			await workflow.recover(owner);
		};
		const ticket = await tickets.create(owner, project.id, {
			title: "Implement search",
			description: "Find files",
		});
		const standalone = await Promise.all([1, 2, 3].map((n) => agents!.create(owner, other.id, `Standalone ${n}`)));
		for (const view of standalone) await agents.send(owner, view.thread.id, "Keep working");
		await tickets.move(owner, ticket.id, { status: "todo" });
		await workflow.tick(owner);
		expect((await jobs.get(ticket.id))?.plannerId).toBeUndefined();
		await agents.interrupt(owner, standalone[0]!.thread.id);
		await workflow.tick(owner);
		const planning = (await jobs.get(ticket.id))!;
		const idle = async () => {
			await workflow.tick(owner);
			return (await jobs.get(ticket.id))?.state;
		};
		await expect.poll(idle).toBe("idle");
		expect((await jobs.get(ticket.id))?.plan?.revision).toBe(1);
		await workflow.message(owner, (await ticketStore.get(ticket.id))!, "Include filtering");
		await workflow.tick(owner);
		await expect.poll(idle).toBe("idle");
		expect((await jobs.get(ticket.id))?.plan?.revision).toBe(2);
		await tickets.move(owner, ticket.id, { status: "in-progress" });
		await workflow.tick(owner);
		await expect.poll(idle).toBe("idle");
		expect((await ticketStore.get(ticket.id))?.status).toBe("in-review");
		const implemented = (await jobs.get(ticket.id))!;
		expect(implemented.workspaceId).toBe(planning.workspaceId);
		expect(implemented.implementerId).not.toBe(planning.plannerId);
		await workflow.message(owner, (await ticketStore.get(ticket.id))!, "Improve empty search");
		await workflow.tick(owner);
		await expect.poll(idle).toBe("idle");
		let reviewed = (await jobs.get(ticket.id))!;
		expect(reviewed.resultSha).not.toBe(implemented.resultSha);
		await workflow.message(owner, (await ticketStore.get(ticket.id))!, "Queued review after restart");
		await restart();
		await workflow.tick(owner);
		await expect.poll(idle).toBe("idle");
		expect((await jobs.get(ticket.id))?.resultSha).not.toBe(reviewed.resultSha);
		reviewed = (await jobs.get(ticket.id))!;
		const { path } = await workspaces.resolve(owner, reviewed.workspaceId!);
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
		await tickets.move(owner, ticket.id, { status: "merging" });
		await workflow.tick(owner);
		expect(await jobs.get(ticket.id)).toMatchObject({ state: "queued", phase: "rebase", mergeAttempts: 1 });
		await workflow.tick(owner);
		// Lose Forge's in-memory history after the noisy rebase finishes, before observing its result.
		await expect
			.poll(async () => (await agents!.get(owner, reviewed.implementerId!)).thread.status)
			.toBe("completed");
		await jobs.save({ ...(await jobs.get(ticket.id))!, state: "uncertain" });
		await restart();
		expect((await agents!.get(owner, reviewed.implementerId!)).truncated).toBe(true);
		await expect.poll(idle).toBe("idle");
		expect((await ticketStore.get(ticket.id))?.status).toBe("done");
		const completed = (await jobs.get(ticket.id))!;
		expect((await git.run(["-C", path, "rev-parse", "main"])).trim()).toBe(completed.resultSha);
		expect(await agents!.list(owner, project.id)).toEqual([]);
		// Reconstruct services from persisted intent at the Git/SQLite crash boundary.
		await jobs.save({ ...completed, state: "queued" }, { status: "merging" });
		await restart();
		await workflow.tick(owner);
		expect((await ticketStore.get(ticket.id))?.status).toBe("done");
		expect((await jobs.get(ticket.id))?.resultSha).toBe(completed.resultSha);
		await expect.poll(async () => (await cost.read(owner, project.id)).totals.input).toBe(6000);
		const recorded = await cost.read(owner, project.id);
		expect(recorded.phases.map(({ phase, turns }) => [phase, turns])).toEqual([
			["planning", 2],
			["implementation", 1],
			["review", 2],
			["rebase", 1],
		]);
		expect(recorded.tickets.at(0)).toMatchObject({
			id: ticket.id,
			cached: 3000,
			untimedTurns: 0,
			unpricedTurns: 0,
		});
		expect(recorded.tickets.at(0)?.apiAud).toBeCloseTo(0.02484);
		expect(recorded.limits?.windows.at(0)).toMatchObject({ minutes: 300, usedPercent: 40 });
		expect((await cost.read(owner, other.id)).phases.map(({ phase }) => phase)).toEqual(["chat"]);
	} finally {
		await agents?.shutdown();
		await usage?.close();
		await connection.close();
		await git.close();
		await db.close();
		await files.rm(root, { recursive: true, force: true });
	}
}, 30_000);
