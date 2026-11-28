import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import type { AgentOptions } from "@forge/contracts/agents";
import { ticketCheckpointSchema, ticketManualMergeSchema, ticketWorkflowSchema } from "@forge/contracts/tickets";
import { expect, test, vi } from "vitest";

import { AccountProcess } from "../../src/accounts/account-process.ts";
import { CodexConnection } from "../../src/accounts/codex-connection.ts";
import { AgentExecutionTracker } from "../../src/agents/agent-execution-tracker.ts";
import { AgentService } from "../../src/agents/agent-service.ts";
import { AgentThreadStore } from "../../src/agents/agent-thread-store.ts";
import { AccessService } from "../../src/auth/access-service.ts";
import { CodexAgentClient } from "../../src/codex/codex-agent-client.ts";
import { CodexUsageClient } from "../../src/codex/codex-usage-client.ts";
import { CostService } from "../../src/cost/cost-service.ts";
import { CostStore } from "../../src/cost/cost-store.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { EpicStore } from "../../src/epics/epic-store.ts";
import { HttpApplication } from "../../src/http/http-application.ts";
import { ModelProviderService } from "../../src/model-providers/model-provider-service.ts";
import { ModelProviderStore } from "../../src/model-providers/model-provider-store.ts";
import { ProjectRouter } from "../../src/projects/project-router.ts";
import { ProjectService } from "../../src/projects/project-service.ts";
import { ProjectStore } from "../../src/projects/project-store.ts";
import { GitDiffClient } from "../../src/repositories/git-diff-client.ts";
import { GitTransport } from "../../src/repositories/git-transport.ts";
import { RepositoryClient } from "../../src/repositories/repository-client.ts";
import { TaskAgentService } from "../../src/task-agents/task-agent-service.ts";
import { TaskAgentStore } from "../../src/task-agents/task-agent-store.ts";
import { completionReportRequirements } from "../../src/tickets/completion-report.ts";
import { TicketHistoryStore } from "../../src/tickets/ticket-history-store.ts";
import { emergencyHandoverSteer, ticketFinalizationPrompt, TicketPrompts } from "../../src/tickets/ticket-prompts.ts";
import { TicketRouter } from "../../src/tickets/ticket-router.ts";
import { TicketService } from "../../src/tickets/ticket-service.ts";
import { TicketStore } from "../../src/tickets/ticket-store.ts";
import { TicketWorkflowService } from "../../src/tickets/ticket-workflow-service.ts";
import { TicketWorkflowStore } from "../../src/tickets/ticket-workflow-store.ts";
import { WorkspaceClient } from "../../src/workspaces/workspace-client.ts";
import { WorkspaceDiffClient } from "../../src/workspaces/workspace-diff-client.ts";
import { WorkspaceMergeClient } from "../../src/workspaces/workspace-merge-client.ts";
import { WorkspaceService } from "../../src/workspaces/workspace-service.ts";
import { WorkspaceStore } from "../../src/workspaces/workspace-store.ts";

const reportIntro = "End your final answer with exactly one JSON object, without Markdown fences or surrounding prose.";
const reportIncomplete =
	'{"status":"incomplete","remaining":"…","summary":"…"} (remaining is required and must be nonblank text of at most 2,000 characters. summary is optional and must be nonblank text of at most 2,000 characters).';
const reportHandoff =
	'{"status":"handoff","handover":"…"} (handover is required and must be nonblank text of at most 1,500 tokens).';
const reportFinish = "Report complete only after finishing your assigned scope and committing the required changes.";
const reportGuidance =
	"In handover or the next-subtask summary, retain concise progress, next actions, decisions, blockers, and verification results as applicable. Omit code dumps, long logs, and repeated plan text.";
const reportBlock = (nonfinal = false, checkpoint = false) =>
	[
		reportIntro,
		"Use only the fields shown for your outcome.",
		nonfinal
			? '{"status":"complete","summary":"…"} (summary is required and must be nonblank text of at most 1,500 tokens).'
			: '{"status":"complete","summary":"…"} (summary is optional and must be nonblank text of at most 2,000 characters).',
		...(checkpoint ? [] : [reportIncomplete]),
		reportHandoff,
		reportFinish,
		"For a handoff, commit only existing uncommitted assignment changes if a safe checkpoint is immediately possible. Report promptly if there are no changes to commit or the checkpoint is blocked.",
		reportGuidance,
	].join(" ");
const legacyBlock =
	'End your final answer with exactly one JSON object, without Markdown fences or surrounding prose: {"status":"complete","summary":"Implemented and verified the assignment"} or {"status":"incomplete","remaining":"Still need to finish the integration tests"}. Summary is optional; remaining is required only for incomplete. Text must be nonblank and at most 2,000 characters. Report complete only after finishing your assigned scope and committing the required changes.';
const retryReminder =
	"The previous run may have left partial work in this worktree. Inspect the current changes and commits before continuing.";
const input = (text: string) => [{ type: "text", text, text_elements: [] }];
const reportOnly = ticketFinalizationPrompt(completionReportRequirements());

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
		let pool = new AgentExecutionTracker();
		const costStore = new CostStore(db);
		await costStore.initialize(new Date().toISOString());
		usage = new CodexUsageClient(
			connection,
			(turn) => costStore.save(turn),
			() => new Date(),
			async () => ({ localCurrency: "AUD", monthlyPlanLocal: 30, usdToLocal: 1.44 }),
			async () => {},
		);
		const rpc = vi.spyOn(connection, "request");
		const turns = (offset = 0) =>
			rpc.mock.calls.slice(offset).filter(([method]) => method === "turn/start" || method === "turn/steer");
		const codexId = async (id: string) => (await agentStore.get(id))!.codexId;
		const expectAssignment = (text: string, nonfinal = false) => {
			expect(text.split(reportIntro)).toHaveLength(2);
			expect(text.endsWith(`\n\n${reportBlock(nonfinal)}`)).toBe(true);
		};
		const turnText = (params: unknown) => (params as { input: { text: string }[] }).input[0]!.text;
		let defaults: Pick<AgentOptions, "defaultModel" | "defaultReasoningEffort"> = {};
		const makeClient = () => {
			const client = new CodexAgentClient(connection, files.realpath, randomUUID, usage);
			const options = client.options.bind(client);
			client.options = async (...args) => ({ ...(await options(...args)), ...defaults });
			return client;
		};
		agents = new AgentService(
			agentStore,
			makeClient(),
			workspaces,
			projects,
			access,
			randomUUID,
			() => new Date(),
			pool,
		);
		const ticketStore = new TicketStore(db);
		await ticketStore.initialize();
		const cost = new CostService(access, ticketStore, costStore, usage, () => new Date());
		const jobs = new TicketWorkflowStore(db);
		await jobs.initialize();
		const providerStore = new ModelProviderStore(db);
		await providerStore.initialize();
		const catalog = makeClient();
		const providers = new ModelProviderService(providerStore, access, randomUUID, (provider) =>
			catalog.options(undefined, provider),
		);
		const provider = await providers.create(owner, { kind: "openai", name: "OpenAI" });
		const taskAgentStore = new TaskAgentStore(db);
		await taskAgentStore.initialize();
		const taskAgents = new TaskAgentService(taskAgentStore, providers, access, randomUUID, () => 0);
		const agent = await taskAgents.save(owner, {
			name: "Developer",
			models: [{ providerId: provider.id, model: "gpt-5.4", reasoningEffort: "high" }],
		});
		const executionSettings = { plannerAgentId: agent.id, implementerAgentId: agent.id };
		const merges = new WorkspaceMergeClient(workspaces, git);
		let dispatch: "running" | "paused" | "stopped" = "running";
		const workflowService = (service: AgentService) =>
			new TicketWorkflowService(
				jobs,
				ticketStore,
				service,
				merges,
				workspaces,
				new TicketPrompts(),
				access,
				undefined,
				() => dispatch,
				workspaces,
				providers,
				taskAgents,
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
			pool = new AgentExecutionTracker();
			agents = new AgentService(
				agentStore,
				makeClient(),
				workspaces,
				projects,
				access,
				randomUUID,
				() => new Date(),
				pool,
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
			executionSettings,
		});
		const standalone = await Promise.all([1, 2, 3].map((n) => agents!.create(owner, other.id, `Standalone ${n}`)));
		for (const view of standalone) await agents.send(owner, view.thread.id, "Keep working");
		dispatch = "paused";
		await tickets.move(owner, ticket.id, { status: "todo" });
		await workflow.tick(owner);
		expect((await jobs.get(ticket.id))?.plannerId).toBeUndefined();
		expect((await tickets.list(owner)).at(0)).toMatchObject({
			agentStatus: "queued",
			assignee: { name: agent.name, avatarColour: "Coral" },
		});
		await agents.interrupt(owner, standalone[0]!.thread.id);
		dispatch = "paused";
		await workflow.tick(owner);
		expect((await ticketStore.get(ticket.id))?.status).toBe("todo");
		expect((await jobs.get(ticket.id))?.plannerId).toBeUndefined();
		dispatch = "running";
		const resolve = workspaces.resolve.bind(workspaces);
		expect((await tickets.list(owner)).at(0)?.agentStatus).toBe("queued");
		vi.spyOn(workspaces, "resolve").mockImplementationOnce(async (...args) => {
			dispatch = "stopped";
			return resolve(...args);
		});
		await workflow.tick(owner);
		const preparedPlanner = (await jobs.get(ticket.id))?.plannerId;
		expect(preparedPlanner).toBeDefined();
		expect((await jobs.get(ticket.id))?.executionRepositoryId).toBe(project.id);
		expect((await workspaces.get(owner, (await jobs.get(ticket.id))!.workspaceId!)).projectId).toBe(project.id);
		expect((await ticketStore.get(ticket.id))?.status).toBe("in-progress");
		await restart();
		expect((await ticketStore.get(ticket.id))?.repositoryIds).toEqual([project.id, other.id]);
		expect((await jobs.get(ticket.id))?.executionRepositoryId).toBe(project.id);
		await workflow.tick(owner);
		expect((await ticketStore.get(ticket.id))?.status).toBe("in-progress");
		expect((await jobs.get(ticket.id))?.state).toBe("queued");
		dispatch = "running";
		defaults = { defaultModel: "gpt-5.4", defaultReasoningEffort: "high" };
		await workflow.recover(owner, ticket.id);
		await workflow.tick(owner);
		const planning = (await jobs.get(ticket.id))!;
		expect(planning.plannerId).toBe(preparedPlanner);
		const planningCall = turns().at(-1)!;
		expect(planningCall).toEqual([
			"turn/start",
			expect.objectContaining({
				threadId: await codexId(planning.plannerId!),
				input: input(turnText(planningCall[1])),
			}),
		]);
		expect(turnText(planningCall[1])).toContain("Return a complete native Markdown plan");
		expect(turnText(planningCall[1])).not.toContain(reportIntro);
		dispatch = "paused";
		const idle = async () => {
			await workflow.tick(owner);
			return (await jobs.get(ticket.id))?.state;
		};
		await expect.poll(idle).toBe("idle");
		expect((await jobs.get(ticket.id))?.plan?.revision).toBe(1);
		expect((await jobs.get(ticket.id))?.plan?.structured?.subtasks[1]).toMatchObject({
			number: 2,
			dependencies: "1",
		});
		const next = await tickets.create(owner, {
			repositoryIds: [project.id],
			title: "Next",
			description: "Wait for capacity",
			executionSettings,
		});
		await tickets.move(owner, next.id, { status: "todo" });
		dispatch = "running";
		await workflow.tick(owner);
		expect((await ticketStore.get(next.id))?.status).toBe("todo");
		await restart();
		expect((await jobs.get(ticket.id))?.plan?.structured?.subtasks[1]?.files).toBe("src/filter.ts");
		await workflow.tick(owner);
		expect((await ticketStore.get(next.id))?.status).toBe("todo");
		await tickets.archive(owner, next.id);
		const extraChat = await agents.create(owner, other.id, "At board capacity");
		await agents.send(owner, extraChat.thread.id, "Keep working");
		dispatch = "paused";
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
		const feedbackCall = turns().at(-1)!;
		expect(feedbackCall[1]).toMatchObject({
			threadId: await codexId(planning.plannerId!),
			input: input(
				turnText(planningCall[1]).replace(
					/^.*?\n\n/,
					"Include filtering\n\nProvide a complete replacement native plan incorporating this feedback.\n\n",
				),
			),
		});
		const revisedPlan = ticketWorkflowSchema.parse(await workflow.get(owner, ticket.id)).plan!;
		expect(revisedPlan.structured?.subtasks.map((task) => task.number)).toEqual([1, 2]);
		expect((await jobs.get(ticket.id))?.plan?.structured?.subtasks[0]?.expectedChanges).toBe(
			"Implement search revision 2",
		);
		expect((await jobs.get(ticket.id))?.plannerId).toBe(planning.plannerId);
		expect(rpc.mock.calls.filter(([method]) => method === "turn/start").at(-1)?.[1]).toMatchObject({
			model: "gpt-5.4",
			effort: "high",
			collaborationMode: { settings: { model: "gpt-5.4", reasoning_effort: "high" } },
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
		expect(ticketWorkflowSchema.parse(await workflow.get(owner, ticket.id))).toMatchObject({
			plan: revisedPlan,
			approvedRevision: 2,
		});
		await workflow.tick(owner);
		await expect.poll(idle).toBe("merge-queued");
		const implementerStarts = rpc.mock.calls.filter(
			([method, params]) =>
				method === "turn/start" && JSON.stringify(params).includes("Implement the approved plan"),
		);
		expect(implementerStarts).toHaveLength(1);
		expectAssignment(turnText(implementerStarts[0]![1]));
		expect(JSON.stringify(implementerStarts[0])).toContain("Implement search revision 2");
		expect(JSON.stringify(implementerStarts[0])).toContain("### 2. Filter");
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
		const rebaseCall = turns().at(-1)!;
		expect(rebaseCall).toEqual([
			"turn/start",
			expect.objectContaining({
				threadId: await codexId(implemented.implementerId!),
				input: input(
					`Rebase this branch onto the latest local main and resolve any conflicts.\n\n${reportBlock()}`,
				),
			}),
		]);
		const beforeReconcile = turns().length;
		await restart();
		expect(turns()).toHaveLength(beforeReconcile);
		expect((await agents!.get(owner, implemented.implementerId!)).truncated).toBe(true);
		expect(await jobs.get(ticket.id)).toMatchObject({ state: "failed", completionFailure: "incomplete" });
		const rebaseThreadId = await codexId(implemented.implementerId!);
		const followUpOffset = rpc.mock.calls.length;
		await workflow.message(owner, (await ticketStore.get(ticket.id))!, "  Review the rebase  ");
		await expect.poll(idle).toBe("failed");
		await workflow.message(owner, (await ticketStore.get(ticket.id))!, "  Verify the rebase  ");
		await restart();
		expect(turns(followUpOffset)).toEqual([
			[
				"turn/start",
				expect.objectContaining({
					threadId: rebaseThreadId,
					input: input("Review the rebase"),
				}),
			],
		]);
		await expect.poll(idle).toBe("merge-queued");
		expect(turns(followUpOffset)).toEqual(
			["Review the rebase", "Verify the rebase", reportOnly].map((text) => [
				"turn/start",
				expect.objectContaining({ threadId: rebaseThreadId, input: input(text) }),
			]),
		);
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
		await expect.poll(async () => (await cost.read(owner)).totals.input).toBe(11000);
		const recorded = await cost.read(owner);
		expect(recorded.phases.filter(({ turns }) => turns).map(({ phase, turns }) => [phase, turns])).toEqual([
			["planning", 2],
			["implementation", 1],
			["rebase", 4],
			["chat", 4],
		]);
		expect(recorded.tickets.at(0)).toMatchObject({
			id: ticket.id,
			archivedAt: archived.archivedAt,
			cached: 3500,
			incomplete: { api: 0 },
		});
		expect(recorded.tickets.at(0)?.apiUsd).toBeCloseTo(0.020125);
		expect(recorded.limits?.windows.at(0)).toMatchObject({ minutes: 300, usedPercent: 40 });
		expect((await cost.read(owner)).phases.map(({ phase }) => phase)).toContain("chat");

		const returning = await tickets.create(owner, {
			repositoryIds: [project.id],
			title: "Restart cleanly",
			description: "Current scope",
			executionSettings,
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
		const partialOffset = rpc.mock.calls.length;
		const partial = await tickets.create(owner, {
			repositoryIds: [project.id],
			title: "Partial work",
			description: "TASK84_CONTROLLED",
			executionSettings: { ...executionSettings, skipPlanning: true },
		});
		const beforePartial = (await git.run(["-C", repository, "rev-parse", "main"])).trim();
		await tickets.move(owner, partial.id, { status: "todo" });
		await workflow.tick(owner);
		const partialJob = (await jobs.get(partial.id))!;
		await expect
			.poll(
				async () => {
					await workflow.tick(owner);
					return (await jobs.get(partial.id))?.completionFailure;
				},
				{ timeout: 10000 },
			)
			.toBe("incomplete");
		expect((await ticketStore.get(partial.id))?.status).toBe("in-progress");
		expect((await git.run(["-C", repository, "rev-parse", "main"])).trim()).toBe(beforePartial);
		const verdict = turns(partialOffset).find(
			([method, params]) => method === "turn/start" && JSON.stringify(params).includes("Assess the assignment"),
		);
		const initialPartial = turns(partialOffset).find(
			([method, params]) => method === "turn/start" && JSON.stringify(params).includes("TASK84_CONTROLLED"),
		);
		expect(initialPartial).toBeDefined();
		expect(verdict?.[1]).toMatchObject({ threadId: (initialPartial![1] as { threadId: string }).threadId });
		expect((await jobs.get(partial.id))?.implementerId).toBe(partialJob.implementerId);
		expect(verdict?.[1]).toMatchObject({ input: input(reportOnly) });
		expectAssignment(turnText(initialPartial![1]));
		const beforeFollowUp = rpc.mock.calls.length;
		await workflow.message(owner, (await ticketStore.get(partial.id))!, "  Finish the integration  ");
		await restart();
		expect(turns(beforeFollowUp)).toEqual([]);
		await expect
			.poll(
				async () => {
					await workflow.tick(owner);
					return (await ticketStore.get(partial.id))?.status;
				},
				{ timeout: 10000 },
			)
			.toBe("done");
		expect(turns(beforeFollowUp)).toEqual([
			[
				"turn/start",
				expect.objectContaining({
					threadId: await codexId(partialJob.implementerId!),
					input: input("Finish the integration"),
				}),
			],
		]);
		await providers.update(owner, provider.id, { compactionThresholdTokens: 8000 });
		const contextRpcStart = rpc.mock.calls.length;
		const contextTicket = await tickets.create(owner, {
			repositoryIds: [project.id],
			title: "Context handoff",
			description: "TASK67_CONTROLLED",
			executionSettings: { ...executionSettings, skipPlanning: true },
		});
		await tickets.move(owner, contextTicket.id, { status: "todo" });
		await workflow.tick(owner);
		const initialContextJob = (await jobs.get(contextTicket.id))!;
		await expect
			.poll(
				async () => {
					await workflow.tick(owner);
					return (await ticketStore.get(contextTicket.id))?.status;
				},
				{ timeout: 10000 },
			)
			.toBe("done");
		const successor = (await jobs.get(contextTicket.id))!;
		expect(successor.workspaceId).toBe(initialContextJob.workspaceId);
		expect(successor.implementerId).not.toBe(initialContextJob.implementerId);
		expect(successor.implementationProviderSnapshot).toEqual(initialContextJob.implementationProviderSnapshot);
		const contextCalls = rpc.mock.calls.slice(contextRpcStart);
		const steers = contextCalls.filter(([method]) => method === "turn/steer");
		expect(steers).toHaveLength(1);
		expect(steers[0]?.[1]).toMatchObject({
			expectedTurnId: initialContextJob.turnId,
			input: [{ type: "text", text: emergencyHandoverSteer }],
		});
		expect(contextCalls.filter(([method]) => method === "turn/start")).toHaveLength(2);
		const handoverCall = rpc.mock.calls.find(
			([method, params]) => method === "turn/start" && JSON.stringify(params).includes("Finish controlled work"),
		);
		expect(JSON.stringify(handoverCall)).toContain("TASK67_CONTROLLED");
		const contextText = turnText(turns(contextRpcStart)[0]![1]);
		expectAssignment(contextText);
		const contextThreadId = await codexId(initialContextJob.implementerId!);
		expect(turns(contextRpcStart)).toEqual([
			["turn/start", expect.objectContaining({ threadId: contextThreadId, input: input(contextText) })],
			[
				"turn/steer",
				{
					threadId: contextThreadId,
					expectedTurnId: initialContextJob.turnId,
					input: input(emergencyHandoverSteer),
				},
			],
			[
				"turn/start",
				expect.objectContaining({
					threadId: await codexId(successor.implementerId!),
					input: input(
						contextText.replace(reportBlock(), `Handover:\nFinish controlled work\n\n${reportBlock()}`),
					),
				}),
			],
		]);
		const startTicket = async (
			description: string,
			workflowPreset: "planner-implementer" | "planner-subtasks" | "one-shot",
		) => {
			const item = await tickets.create(owner, {
				repositoryIds: [project.id],
				title: description,
				description,
				executionSettings: { ...executionSettings, workflowPreset },
			});
			await tickets.move(owner, item.id, { status: "todo" });
			await workflow.tick(owner);
			return item.id;
		};
		const pollJob = async (id: string) => {
			await workflow.tick(owner);
			return jobs.get(id);
		};
		const assertQuiet = async () => {
			const count = turns().length;
			await restart();
			await workflow.tick(owner);
			await workflow.recover(owner);
			expect(turns()).toHaveLength(count);
		};

		const singleOffset = rpc.mock.calls.length;
		const singleId = await startTicket("TASK94_SINGLE", "planner-implementer");
		await expect.poll(() => pollJob(singleId)).toMatchObject({ phase: "planning", state: "idle" });
		const single = (await jobs.get(singleId))!;
		expect(single.plan?.structured?.subtasks).toEqual([]);
		const singlePrompt = turnText(turns(singleOffset)[0]![1]);
		expect(singlePrompt).toContain("Return a complete native Markdown plan");
		expect(singlePrompt).not.toMatch(/Ordered subtasks|exactly one JSON object/);
		await expect(workflow.approve(owner, (await ticketStore.get(singleId))!, 2)).rejects.toThrow("ticket-conflict");
		expect(turns(singleOffset)).toEqual([
			[
				"turn/start",
				expect.objectContaining({
					threadId: await codexId(single.plannerId!),
					input: input(singlePrompt),
				}),
			],
		]);
		await workflow.approve(owner, (await ticketStore.get(singleId))!, 1);
		await expect
			.poll(async () => {
				await pollJob(singleId);
				return (await ticketStore.get(singleId))!.status;
			})
			.toBe("done");
		expectAssignment(turnText(turns(singleOffset)[1]![1]));
		expect(turns(singleOffset)).toHaveLength(2);

		const invalidOffset = rpc.mock.calls.length;
		const invalidId = await startTicket("TASK94_INVALID", "one-shot");
		await expect
			.poll(() => pollJob(invalidId))
			.toMatchObject({ state: "failed", completionFailure: "invalid-report" });
		const invalid = (await jobs.get(invalidId))!;
		const invalidThreadId = await codexId(invalid.implementerId!);
		await assertQuiet();
		expect(turns(invalidOffset)).toEqual([
			["turn/start", expect.objectContaining({ threadId: invalidThreadId })],
			["turn/start", expect.objectContaining({ threadId: invalidThreadId, input: input(reportOnly) })],
		]);
		await workflow.message(owner, (await ticketStore.get(invalidId))!, "  $review Finish after invalid  ");
		await expect
			.poll(async () => {
				await pollJob(invalidId);
				return (await ticketStore.get(invalidId))!.status;
			})
			.toBe("done");
		expect(turns(invalidOffset)).toHaveLength(3);
		expect(turns(invalidOffset)[2]).toEqual([
			"turn/start",
			expect.objectContaining({
				threadId: invalidThreadId,
				input: [
					...input("$review Finish after invalid"),
					{ type: "skill", name: "review", path: "/skills/review/SKILL.md" },
				],
			}),
		]);

		const legacyOffset = rpc.mock.calls.length;
		const legacyId = await startTicket("TASK94_LOW", "one-shot");
		await expect.poll(() => pollJob(legacyId)).toMatchObject({ state: "failed", contextFailure: "headroom" });
		const legacy = (await jobs.get(legacyId))!;
		await jobs.save({
			...legacy,
			context: {
				...legacy.context!,
				prompt: `Recover legacy work\n\n${legacyBlock}\n\n${reportBlock(true)}`,
				handover: "Retain the checkpoint",
			},
		});
		await assertQuiet();
		await workflow.message(owner, (await ticketStore.get(legacyId))!, `  ${legacyBlock}  `);
		await restart();
		expect(turns(legacyOffset).map(([method]) => method)).toEqual(["turn/start", "turn/steer"]);
		await workflow.tick(owner);
		expect((await jobs.get(legacyId))?.context?.prompt).toBe("Recover legacy work");
		await expect
			.poll(async () => {
				await pollJob(legacyId);
				return (await ticketStore.get(legacyId))!.status;
			})
			.toBe("done");
		const legacyRetry = (await jobs.get(legacyId))!;
		expect(legacyRetry).toMatchObject({
			workspaceId: legacy.workspaceId,
			implementationProviderSnapshot: legacy.implementationProviderSnapshot,
		});
		expect(legacyRetry.implementerId).not.toBe(legacy.implementerId);
		expect(turns(legacyOffset).at(-1)).toEqual([
			"turn/start",
			expect.objectContaining({
				threadId: await codexId(legacyRetry.implementerId!),
				input: input(
					`Recover legacy work\n\n${retryReminder}\n\nHandover:\nRetain the checkpoint\n\n${reportBlock()}`,
				),
			}),
		]);
		await assertQuiet();

		const orderedPlanningOffset = rpc.mock.calls.length;
		const orderedId = await startTicket("Ordered recovery", "planner-subtasks");
		await expect.poll(() => pollJob(orderedId)).toMatchObject({ phase: "planning", state: "idle" });
		const orderedPlanning = turns(orderedPlanningOffset);
		expect(orderedPlanning).toHaveLength(1);
		expect(turnText(orderedPlanning[0]![1])).toMatch(
			/Return a complete native Markdown plan.*Under Ordered subtasks/,
		);
		expect(turnText(orderedPlanning[0]![1])).not.toContain(reportIntro);
		const orderedOffset = rpc.mock.calls.length;
		await workflow.approve(owner, (await ticketStore.get(orderedId))!, 1);
		await workflow.tick(owner);
		await expect
			.poll(async () => {
				await workflow.tick(owner);
				return (await jobs.get(orderedId))?.subtaskIndex;
			})
			.toBe(1);
		await workflow.tick(owner);
		const ordered = (await jobs.get(orderedId))!;
		const orderedThread = await codexId(ordered.implementerId!);
		const firstScope = turnText(turns(orderedOffset)[0]![1]);
		expect(firstScope).toMatch(/^Implement only subtask 1: Search\./);
		expect(firstScope).not.toContain("Add filtering");
		expectAssignment(firstScope, true);
		const secondScope = turnText(turns(orderedOffset)[1]![1]);
		expect(secondScope).toMatch(/^Implement only subtask 2: Filter\./);
		expect(secondScope).toContain("Previous subtask summary:\nSearch checkpoint verified");
		expectAssignment(secondScope);
		const steeringOffset = rpc.mock.calls.length;
		const orderedTicket = (await ticketStore.get(orderedId))!;
		await expect(workflow.message(owner, orderedTicket, "Stale", "old-turn")).rejects.toThrow("ticket-conflict");
		await workflow.message(owner, orderedTicket, "  $review the changes  ", ordered.turnId);
		await expect.poll(async () => (await agents!.get(owner, ordered.implementerId!)).thread.status).toBe("waiting");
		await expect(workflow.message(owner, orderedTicket, "Waiting", ordered.turnId)).rejects.toThrow(
			"agent-conflict",
		);
		await workflow.tick(owner);
		await workflow.tick(owner);
		expect(turns(steeringOffset)).toEqual([
			[
				"turn/steer",
				{
					threadId: orderedThread,
					expectedTurnId: ordered.turnId,
					input: [
						...input("$review the changes"),
						{ type: "skill", name: "review", path: "/skills/review/SKILL.md" },
					],
				},
			],
		]);
		const pending = (await agents!.get(owner, ordered.implementerId!)).requests[0]!;
		await agents!.reply(owner, ordered.implementerId!, { requestId: pending.id, decision: "accept" });
		await expect.poll(() => pollJob(orderedId)).toMatchObject({ state: "failed", contextFailure: "headroom" });
		expect(turns(steeringOffset).map(([method]) => method)).toEqual(["turn/steer", "turn/steer"]);
		expect(turns(steeringOffset)[1]![1]).toMatchObject({ threadId: orderedThread, expectedTurnId: ordered.turnId });
		await assertQuiet();
		const orderedRetryOffset = rpc.mock.calls.length;
		await workflow.message(owner, orderedTicket, `  Recover ordered work\n\n${reportBlock(true)}  `);
		await restart();
		expect(turns(orderedRetryOffset)).toEqual([]);
		await workflow.tick(owner);
		const orderedRetry = (await jobs.get(orderedId))!;
		expect(orderedRetry).toMatchObject({
			workspaceId: ordered.workspaceId,
			subtaskIndex: 1,
			implementationProviderSnapshot: ordered.implementationProviderSnapshot,
		});
		expect(orderedRetry.implementerId).not.toBe(ordered.implementerId);
		expect(turns(orderedRetryOffset)).toEqual([
			[
				"turn/start",
				expect.objectContaining({
					threadId: await codexId(orderedRetry.implementerId!),
					input: input(
						secondScope.replace(
							"Previous subtask summary:",
							`${retryReminder}\n\nRecovery instruction:\nRecover ordered work\n\nPrevious subtask summary:`,
						),
					),
				}),
			],
		]);
		expect(orderedRetry.context?.prompt).not.toContain(reportIntro);
		await expect
			.poll(async () => {
				await pollJob(orderedId);
				return (await ticketStore.get(orderedId))!.status;
			})
			.toBe("done");
		await assertQuiet();
		for (const [mode, failure] of [
			["REPORT", undefined],
			["UNKNOWN", "telemetry"],
			["CHANGED", "checkpoint"],
			["NO_PROGRESS", "no-progress"],
			["AMBIGUOUS", undefined],
		] as const) {
			const offset = rpc.mock.calls.length;
			const id = await startTicket(`TASK94_CHECKPOINT_${mode}`, "one-shot");
			const initial = (await jobs.get(id))!;
			const threadId = await codexId(initial.implementerId!);
			if (mode === "CHANGED") {
				await expect.poll(() => pollJob(id)).toMatchObject({ state: "queued", context: { stage: "report" } });
				const { path: checkpointPath } = await workspaces.resolve(owner, initial.workspaceId!);
				await git.run([
					"-C",
					checkpointPath,
					"-c",
					"user.name=Owner",
					"-c",
					"user.email=owner@example.com",
					"commit",
					"--allow-empty",
					"-m",
					"Change recorded checkpoint",
				]);
			}
			if (failure) {
				await expect.poll(() => pollJob(id)).toMatchObject({ state: "failed", contextFailure: failure });
			} else if (mode === "REPORT") {
				await expect
					.poll(async () => {
						await pollJob(id);
						return (await ticketStore.get(id))!.status;
					})
					.toBe("done");
			} else {
				await pollJob(id);
			}
			await assertQuiet();
			const actual = turns(offset);
			expect(actual.map(([method]) => method)).toEqual(
				mode === "REPORT" ? ["turn/start", "turn/steer", "turn/start"] : ["turn/start", "turn/steer"],
			);
			expect(actual[1]![1]).toMatchObject({ threadId, expectedTurnId: initial.turnId });
			if (mode === "REPORT")
				expect(actual[2]![1]).toMatchObject({
					threadId,
					input: input(ticketFinalizationPrompt(completionReportRequirements(true))),
				});
			if (mode === "AMBIGUOUS") {
				await agents!.interrupt(owner, initial.implementerId!);
				await pollJob(id);
			}
			if (mode !== "REPORT") {
				await tickets.move(owner, id, { status: "backlog" });
				await workflow.recover(owner, id);
			}
		}
		for (const stage of ["before", "after"] as const) {
			const failedTicket = await tickets.create(owner, {
				repositoryIds: [project.id],
				title: `Setup failure ${stage}`,
				description: "",
				executionSettings,
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

test("owner recovery uses real Git and SQLite without the agent runtime", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-ticket-recovery-"));
	const db = new SqliteDatabase(join(root, "forge.sqlite"));
	const git = new GitTransport(undefined, {
		identity: () => ({ name: "Recovery Owner", email: "owner@example.com" }),
	});
	try {
		await db.initialize();
		const owner = { username: "owner" };
		const access = new AccessService({ owner: owner.username, origin: "https://forge.example" });
		const projectsStore = new ProjectStore(db);
		await projectsStore.initialize();
		const repositories = new RepositoryClient(root, [], files, git);
		const projects = new ProjectService(projectsStore, repositories, access, randomUUID, () => new Date());
		const project = await projects.create(owner, { name: "Project" });
		const repository = join(root, "repositories", `${project.id}.git`);
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
		const ticketStore = new TicketStore(db);
		await ticketStore.initialize();
		const jobs = new TicketWorkflowStore(db);
		await jobs.initialize();
		const runtimeUnavailable = vi.fn(async () => {
			throw new Error("Agent runtime unavailable");
		});
		const agents = {
			stopTicket: runtimeUnavailable,
			catalogOptions: runtimeUnavailable,
			assertRepositoryReady: runtimeUnavailable,
			steer: runtimeUnavailable,
			createTicketThread: runtimeUnavailable,
			dispatch: runtimeUnavailable,
			plan: runtimeUnavailable,
			get: runtimeUnavailable,
			resume: runtimeUnavailable,
		};
		const workflowService = () =>
			new TicketWorkflowService(
				jobs,
				ticketStore,
				agents,
				new WorkspaceMergeClient(workspaces, git),
				workspaces,
				new TicketPrompts(),
				access,
				undefined,
				() => "stopped",
				workspaces,
				undefined,
				undefined,
				undefined,
				workspaces,
			);
		const workflow = workflowService();
		const tickets = new TicketService(
			ticketStore,
			projectsStore,
			access,
			() => new Date(),
			workflow,
			new EpicStore(db),
		);
		const manual = await tickets.create(owner, {
			repositoryIds: [project.id],
			title: "Recover work",
			description: "",
		});
		const workspace = await workspaces.create(owner, project.id, { name: manual.id });
		const { path: checkout } = await workspaces.resolve(owner, workspace.id);
		const run = (...args: string[]) => git.run(["-C", checkout, ...args]);
		await jobs.save(
			{
				ticketId: manual.id,
				phase: "implementation",
				state: "uncertain",
				mergeAttempts: 0,
				workspaceId: workspace.id,
			},
			{ status: "in-progress" },
		);
		const historyStore = new TicketHistoryStore(db);
		await using server = createServer(
			new HttpApplication(new ProjectRouter(projects), access)
				.create([new TicketRouter(tickets, workflow, historyStore)])
				.callback(),
		);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No listener");
		const post = (action: string, username = "owner", origin = "https://forge.example", body = {}) =>
			fetch(`http://127.0.0.1:${address.port}/api/tickets/${manual.id}/${action}`, {
				method: "POST",
				headers: { "x-webauth-user": username, origin, "content-type": "application/json" },
				body: JSON.stringify(body),
			});
		const checkpoint = "commit-checkpoint";
		const land = "merge-into-main";
		for (const action of [checkpoint, land]) {
			expect((await post(action, "intruder")).status).toBe(403);
			expect((await post(action, "owner", "https://other.example")).status).toBe(403);
			expect((await post(action, "owner", "https://forge.example", { extra: true })).status).toBe(400);
		}
		await files.writeFile(join(checkout, ".gitignore"), "ignored.txt\n");
		await files.writeFile(join(checkout, "ignored.txt"), "keep me\n");
		await files.writeFile(join(checkout, "new.txt"), "indexed\n");
		await run("add", "new.txt");
		await files.writeFile(join(checkout, "new.txt"), "after staging\n");
		await files.writeFile(join(checkout, "untracked.txt"), "new file\n");
		const dirty = await post(land);
		expect(dirty.status).toBe(409);
		expect(await dirty.json()).toEqual({ error: "ticket-worktree-dirty" });
		const gitDir = (await run("rev-parse", "--absolute-git-dir")).trim();
		await files.writeFile(join(gitDir, "CHERRY_PICK_HEAD"), workspace.head!);
		for (const action of [checkpoint, land]) {
			const inProgress = await post(action);
			expect(inProgress.status).toBe(409);
			expect(await inProgress.json()).toEqual({ error: "ticket-git-in-progress" });
		}
		await files.rm(join(gitDir, "CHERRY_PICK_HEAD"));
		const first = ticketCheckpointSchema.parse(await (await post(checkpoint)).json());
		expect(first.outcome).toBe("committed");
		expect(await run("show", "HEAD:new.txt")).toBe("after staging\n");
		expect(await run("show", "HEAD:untracked.txt")).toBe("new file\n");
		expect(await run("ls-files", "ignored.txt")).toBe("");
		expect((await run("log", "-1", "--format=%an <%ae>%n%s")).trim()).toBe(
			`Recovery Owner <owner@example.com>\nCheckpoint ${manual.id}`,
		);
		expect((await run("rev-parse", "main")).trim()).toBe(workspace.head);
		expect((await jobs.get(manual.id))?.state).toBe("uncertain");
		await files.rm(join(checkout, "new.txt"));
		const final = ticketCheckpointSchema.parse(await (await post(checkpoint)).json());
		expect(final.outcome).toBe("committed");
		expect(await run("diff", "--name-status", first.sha, final.sha)).toBe("D\tnew.txt\n");
		expect(ticketCheckpointSchema.parse(await (await post(checkpoint)).json())).toEqual({
			outcome: "unchanged",
			sha: final.sha,
		});
		const merged = ticketManualMergeSchema.parse(await (await post(land)).json());
		expect(merged).toMatchObject({ sha: final.sha, workflow: { state: "idle", cleanupPending: true } });
		expect((await run("rev-parse", "main")).trim()).toBe(final.sha);
		expect((await tickets.get(owner, manual.id)).status).toBe("done");
		expect((await post(land)).status).toBe(409);
		const history = (await historyStore.read(manual.id, 0)).events;
		expect(history.filter(({ type }) => type === "merged")).toHaveLength(1);
		expect(history.some(({ type }) => type === "implemented")).toBe(false);
		expect(runtimeUnavailable).not.toHaveBeenCalled();
		await files.writeFile(join(checkout, "after-merge.txt"), "preserve this\n");
		await workflow.tick(owner);
		await vi.waitFor(async () => expect((await jobs.get(manual.id))?.cleanupFailed).toBe(true));
		expect(await files.readFile(join(checkout, "after-merge.txt"))).toBe("preserve this\n");
		expect(await files.readFile(join(checkout, "ignored.txt"))).toBe("keep me\n");

		const interrupted = await tickets.create(owner, {
			repositoryIds: [project.id],
			title: "Interrupted merge",
			description: "",
		});
		const interruptedWorkspace = await workspaces.create(owner, project.id, { name: interrupted.id });
		const { path: interruptedPath } = await workspaces.resolve(owner, interruptedWorkspace.id);
		await jobs.save(
			{
				ticketId: interrupted.id,
				phase: "implementation",
				state: "failed",
				mergeAttempts: 0,
				workspaceId: interruptedWorkspace.id,
			},
			{ status: "in-progress" },
		);
		await expect(workflow.mergeIntoMain(owner, interrupted.id)).rejects.toThrow("ticket-no-commits");
		await files.writeFile(join(interruptedPath, "recovered.txt"), "recover the exact candidate\n");
		const { sha } = await workflow.commitCheckpoint(owner, interrupted.id);
		const save = jobs.save.bind(jobs);
		const saveSpy = vi.spyOn(jobs, "save").mockImplementation(async (record, move) => {
			if (record.ticketId === interrupted.id && move?.status === "done")
				throw new Error("Stopped after the ref update");
			await save(record, move);
		});
		try {
			await expect(workflow.mergeIntoMain(owner, interrupted.id)).rejects.toThrow("ticket-unavailable");
		} finally {
			saveSpy.mockRestore();
		}
		expect((await jobs.get(interrupted.id))?.manualMergeSha).toBe(sha);
		expect((await ticketStore.get(interrupted.id))?.status).toBe("in-progress");
		expect((await git.run(["-C", repository, "rev-parse", "main"])).trim()).toBe(sha);
		const reopened = workflowService();
		await reopened.recover(owner, interrupted.id);
		await reopened.recover(owner, interrupted.id);
		await vi.waitFor(async () => expect((await jobs.get(interrupted.id))?.workspaceCleaned).toBe(true));
		expect((await ticketStore.get(interrupted.id))?.status).toBe("done");
		expect((await jobs.get(interrupted.id))?.manualMergeSha).toBeUndefined();
		expect(
			(await historyStore.read(interrupted.id, 0)).events.filter(({ type }) => type === "merged"),
		).toHaveLength(1);
	} finally {
		await git.close();
		await db.close();
		await files.rm(root, { recursive: true, force: true });
	}
}, 15_000);
