import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as files from "@forge/backend-infrastructure/file";
import { createLogger } from "@forge/backend-infrastructure/logger";
import { sleep } from "@forge/backend-infrastructure/sleep";

import { AccountAttemptStore } from "./accounts/account-attempt-store.ts";
import { AccountProcess } from "./accounts/account-process.ts";
import { AccountRouter } from "./accounts/account-router.ts";
import { AccountService } from "./accounts/account-service.ts";
import { CodexAccountClient } from "./accounts/codex-account-client.ts";
import { CodexConnection } from "./accounts/codex-connection.ts";
import { GithubAccountClient } from "./accounts/github-account-client.ts";
import { AgentExecutionPool } from "./agents/agent-execution-pool.ts";
import { AgentRouter } from "./agents/agent-router.ts";
import { AgentService } from "./agents/agent-service.ts";
import { AgentThreadStore } from "./agents/agent-thread-store.ts";
import { AccessService } from "./auth/access-service.ts";
import { CodexAgentClient } from "./codex/codex-agent-client.ts";
import { CodexUsageClient } from "./codex/codex-usage-client.ts";
import { Configuration } from "./config/configuration.ts";
import { CostRouter } from "./cost/cost-router.ts";
import { CostService } from "./cost/cost-service.ts";
import { CostStore } from "./cost/cost-store.ts";
import { SqliteDatabase } from "./database/sqlite-database.ts";
import { HttpApplication } from "./http/http-application.ts";
import type { ILifecycle } from "./http/lifecycle.ts";
import { StaticAssets } from "./http/static-assets.ts";
import { ProjectRouter } from "./projects/project-router.ts";
import { ProjectService } from "./projects/project-service.ts";
import { ProjectStore } from "./projects/project-store.ts";
import { PullRequestClient } from "./pull-requests/pull-request-client.ts";
import { PullRequestRouter } from "./pull-requests/pull-request-router.ts";
import { PullRequestService } from "./pull-requests/pull-request-service.ts";
import { PullRequestStore } from "./pull-requests/pull-request-store.ts";
import { GitDiffClient } from "./repositories/git-diff-client.ts";
import { GitTransport } from "./repositories/git-transport.ts";
import { RepositoryBrowserClient } from "./repositories/repository-browser-client.ts";
import { RepositoryBrowserRouter } from "./repositories/repository-browser-router.ts";
import { RepositoryBrowserService } from "./repositories/repository-browser-service.ts";
import { RepositoryClient } from "./repositories/repository-client.ts";
import { TerminalInventory } from "./terminal/terminal-inventory.ts";
import { TerminalProcess } from "./terminal/terminal-process.ts";
import { TerminalRouter } from "./terminal/terminal-router.ts";
import { TerminalService } from "./terminal/terminal-service.ts";
import { TerminalSocket } from "./terminal/terminal-socket.ts";
import { TerminalStore } from "./terminal/terminal-store.ts";
import { TicketPrompts } from "./tickets/ticket-prompts.ts";
import { TicketRouter } from "./tickets/ticket-router.ts";
import { TicketService } from "./tickets/ticket-service.ts";
import { TicketStore } from "./tickets/ticket-store.ts";
import { TicketWorkflowService } from "./tickets/ticket-workflow-service.ts";
import { TicketWorkflowStore } from "./tickets/ticket-workflow-store.ts";
import type { StartOptions } from "./types.ts";
import { WorkspaceClient } from "./workspaces/workspace-client.ts";
import { WorkspaceDiffClient } from "./workspaces/workspace-diff-client.ts";
import { WorkspaceMergeClient } from "./workspaces/workspace-merge-client.ts";
import { WorkspaceRouter } from "./workspaces/workspace-router.ts";
import { WorkspaceService } from "./workspaces/workspace-service.ts";
import { WorkspaceStore } from "./workspaces/workspace-store.ts";

export const start = async (lifecycle: ILifecycle, options: StartOptions = {}): Promise<void> => {
	process.umask(0o077);
	const log = createLogger("Forge");
	const config = new Configuration(process.env).load();
	await files.mkdir(config.dataDirectory, { recursive: true, mode: 0o700 });
	if (!(await files.lstat(config.dataDirectory)).isDirectory())
		throw new Error("Forge data root must be a directory");
	await files.chmod(config.dataDirectory, 0o700);
	if (!lifecycle.isOpen()) return;
	const database = new SqliteDatabase(join(config.dataDirectory, "forge.sqlite"));
	lifecycle.register(() => database.close());
	await database.initialize();
	if (!lifecycle.isOpen()) return;
	const store = new ProjectStore(database);
	await store.initialize();
	if (!lifecycle.isOpen()) return;
	const access = new AccessService(config);
	const ticketStore = new TicketStore(database);
	await ticketStore.initialize();
	const costStore = new CostStore(database);
	await costStore.initialize(new Date().toISOString());
	const git = options.git ?? new GitTransport(sleep);
	const differences = new GitDiffClient(git);
	const repositories = new RepositoryClient(config.dataDirectory, config.importHosts, files, git);
	const projects = new ProjectService(store, repositories, access, randomUUID, () => new Date());
	let recovery = Promise.resolve();
	lifecycle.register(async () => {
		await git.close();
		await recovery.catch(() => {});
	});
	recovery = projects.recover();
	await recovery;
	if (!lifecycle.isOpen()) return;
	const workspaceStore = new WorkspaceStore(database);
	await workspaceStore.initialize();
	const workspaceClient = new WorkspaceClient(config.dataDirectory, files, git, repositories);
	const workspaces = new WorkspaceService(
		workspaceStore,
		workspaceClient,
		projects,
		access,
		randomUUID,
		() => new Date(),
		new WorkspaceDiffClient(workspaceClient, git, files, differences),
	);
	recovery = workspaces.recover();
	await recovery;
	if (!lifecycle.isOpen()) return;
	const terminalStore = new TerminalStore(database);
	const pullRequestStore = new PullRequestStore(database);
	await pullRequestStore.initialize();
	const pullRequests = new PullRequestService(
		pullRequestStore,
		new PullRequestClient(workspaces, git, differences),
		access,
		randomUUID,
		() => new Date(),
	);
	await terminalStore.initialize();
	const terminals = new TerminalService(
		terminalStore,
		new TerminalProcess(process.env["PATH"] ?? "", sleep, new TerminalInventory(files), process.platform),
		workspaces,
		access,
		randomUUID,
		() => new Date(),
		sleep,
	);
	lifecycle.register(() => terminals.shutdown());
	await terminals.recover();
	if (!lifecycle.isOpen()) return;
	const attempts = new AccountAttemptStore(database);
	await attempts.initialize();
	if (!lifecycle.isOpen()) return;
	const processes = new AccountProcess(
		{
			dataDirectory: config.dataDirectory,
			path: process.env["PATH"] ?? "",
			codexExecutable: fileURLToPath(new URL("../node_modules/.bin/codex", import.meta.url)),
			githubExecutable: "gh",
		},
		sleep,
	);
	// Credential-home failure is reported by account APIs, without withholding project HTTP or health.
	try {
		await processes.initialize();
	} catch (err) {
		log.warn({ err }, "Account credential homes unavailable");
	}
	if (!lifecycle.isOpen()) return;
	const connection = new CodexConnection(processes, sleep);
	lifecycle.register(() => connection.close());
	const usage = new CodexUsageClient(
		connection,
		(turn) => costStore.save(turn),
		() => new Date(),
		config.cost.monthlyAud,
	);
	lifecycle.register(() => usage.close());
	const cost = new CostService(projects, ticketStore, costStore, usage, config.cost, () => new Date());
	const codex = new CodexAccountClient(connection, attempts);
	const github = new GithubAccountClient(processes, sleep, attempts);
	lifecycle.register(() => github.close());
	const accounts = new AccountService(access, codex, github);
	const agentStore = new AgentThreadStore(database);
	await agentStore.initialize();
	await agentStore.recover();
	let wakeRequested = false;
	let schedulerWait: AbortController | undefined;
	const wakeScheduler = () => {
		wakeRequested = true;
		schedulerWait?.abort();
	};
	const pool = new AgentExecutionPool(wakeScheduler);
	const agents = new AgentService(
		agentStore,
		new CodexAgentClient(connection, files.realpath, randomUUID, usage),
		workspaces,
		projects,
		access,
		randomUUID,
		() => new Date(),
		pool,
	);
	lifecycle.register(() => agents.shutdown());
	const workflowStore = new TicketWorkflowStore(database);
	await workflowStore.initialize();
	const workflow = new TicketWorkflowService(
		workflowStore,
		ticketStore,
		agents,
		pool,
		new WorkspaceMergeClient(workspaces, git),
		new TicketPrompts(),
		access,
		wakeScheduler,
	);
	const tickets = new TicketService(ticketStore, store, access, () => new Date(), workflow);
	const actor = { username: config.owner };
	await agents.seed(actor);
	const workflowAbort = new AbortController();
	const workflowLoop = (async () => {
		await agents.recover(actor);
		await workflow.recover(actor);
		while (!workflowAbort.signal.aborted) {
			wakeRequested = false;
			try {
				await workflow.tick(actor);
			} catch (err) {
				log.error({ err }, "Ticket scheduler failed");
			}
			if (wakeRequested || workflowAbort.signal.aborted) continue;
			schedulerWait = new AbortController();
			try {
				await sleep(500, AbortSignal.any([workflowAbort.signal, schedulerWait.signal]));
			} catch (err) {
				if (!schedulerWait.signal.aborted && !workflowAbort.signal.aborted) throw err;
			} finally {
				schedulerWait = undefined;
			}
		}
	})();
	lifecycle.register(async () => {
		workflowAbort.abort();
		await workflowLoop;
	});
	const agentRouter = new AgentRouter(agents, sleep);
	lifecycle.register(() => agentRouter.close());
	const assets = new StaticAssets(fileURLToPath(new URL("../packages/frontend/dist", import.meta.url)), files);
	if (!(await assets.read("/"))) throw new Error("Build Forge frontend before starting the application");
	if (!lifecycle.isOpen()) return;
	const app = new HttpApplication(new ProjectRouter(projects), access).create(
		[
			new AccountRouter(accounts),
			agentRouter,
			new TicketRouter(tickets, workflow),
			new CostRouter(cost),
			new WorkspaceRouter(workspaces),
			new RepositoryBrowserRouter(
				new RepositoryBrowserService(
					new RepositoryBrowserClient(config.dataDirectory, git, repositories),
					projects,
					access,
				),
			),
			new TerminalRouter(terminals),
			new PullRequestRouter(pullRequests),
		],
		assets,
	);
	app.on("error", (err) => log.error({ err }, "HTTP request failed"));
	const server = createServer(app.callback());
	const terminalSockets = new TerminalSocket(terminals, access, sleep);
	terminalSockets.register(server);
	lifecycle.register(() => terminalSockets.close());
	let listening: Promise<void> = Promise.resolve();
	lifecycle.register(() =>
		listening
			.catch(() => {})
			.then(() =>
				(async () => {
					if (!server.listening) {
						return;
					}
					const drained = new Promise<void>((resolve, reject) =>
						server.close((error) => (error ? reject(error) : resolve())),
					);
					server.closeIdleConnections();
					await agentRouter.close();
					await agents.shutdown();
					await terminalSockets.close();
					await terminals.shutdown();
					await git.close();
					await drained;
				})(),
			),
	);
	listening = new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			reject(error);
		};
		server.once("error", onError);
		server.listen(config.port, "0.0.0.0", () => {
			server.off("error", onError);
			resolve();
		});
	});
	await listening;
	if (!lifecycle.isOpen()) return;
	server.on("error", (error) => {
		throw error;
	});
	log.info({ port: config.port }, "Forge listening");
	void connection
		.initialize()
		.catch((err: unknown) => log.warn({ err }, "Codex unavailable; project HTTP remains available"));
};
