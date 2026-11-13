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
import { ExchangeRateCacheStore, ExchangeRates, FrankfurterClient } from "./cost/exchange-rate.ts";
import { QuotaCollector } from "./cost/quota-collector.ts";
import { QuotaStore } from "./cost/quota-store.ts";
import { SqliteDatabase } from "./database/sqlite-database.ts";
import { DockerClient } from "./docker/docker-client.ts";
import { DockerCommand } from "./docker/docker-command.ts";
import { DockerRouter } from "./docker/docker-router.ts";
import { DockerService } from "./docker/docker-service.ts";
import { EpicRouter } from "./epics/epic-router.ts";
import { EpicService } from "./epics/epic-service.ts";
import { EpicStore } from "./epics/epic-store.ts";
import { HttpApplication } from "./http/http-application.ts";
import type { ILifecycle } from "./http/lifecycle.ts";
import { StaticAssets } from "./http/static-assets.ts";
import { ActProcess } from "./pipelines/act-process.ts";
import { GitSnapshotClient } from "./pipelines/git-snapshot-client.ts";
import { PipelineRouter } from "./pipelines/pipeline-router.ts";
import { PipelineService } from "./pipelines/pipeline-service.ts";
import { PipelineStore } from "./pipelines/pipeline-store.ts";
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
import { UpstreamSyncClient } from "./repositories/upstream-sync-client.ts";
import { UpstreamSyncRouter } from "./repositories/upstream-sync-router.ts";
import { UpstreamSyncService } from "./repositories/upstream-sync-service.ts";
import { GitSystemConfig } from "./settings/git-system-config.ts";
import { SettingsRouter } from "./settings/settings-router.ts";
import { SettingsService } from "./settings/settings-service.ts";
import { SettingsStore } from "./settings/settings-store.ts";
import { TerminalInventory } from "./terminal/terminal-inventory.ts";
import { TerminalProcess } from "./terminal/terminal-process.ts";
import { TerminalRouter } from "./terminal/terminal-router.ts";
import { TerminalService } from "./terminal/terminal-service.ts";
import { TerminalSocket } from "./terminal/terminal-socket.ts";
import { TerminalStore } from "./terminal/terminal-store.ts";
import { BoardSettingsRouter } from "./tickets/board-settings-router.ts";
import { BoardSettingsService } from "./tickets/board-settings-service.ts";
import { BoardSettingsStore } from "./tickets/board-settings-store.ts";
import { TicketHistoryStore } from "./tickets/ticket-history-store.ts";
import { TicketPrompts } from "./tickets/ticket-prompts.ts";
import { TicketRouter } from "./tickets/ticket-router.ts";
import { TicketService } from "./tickets/ticket-service.ts";
import { TicketStore } from "./tickets/ticket-store.ts";
import { TicketWorkflowService } from "./tickets/ticket-workflow-service.ts";
import { TicketWorkflowStore } from "./tickets/ticket-workflow-store.ts";
import type { StartOptions } from "./types.ts";
import { AbandonedWorkspaceCleanup } from "./workspaces/abandoned-workspace-cleanup.ts";
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
	const dockerCommand = new DockerCommand(sleep);
	lifecycle.register(() => dockerCommand.close());
	const docker = new DockerService(new DockerClient(dockerCommand), access, randomUUID, () => new Date());
	const costStore = new CostStore(database);
	await costStore.initialize(new Date().toISOString());
	const processes = new AccountProcess(
		{
			dataDirectory: config.dataDirectory,
			path: process.env["PATH"] ?? "",
			codexExecutable: fileURLToPath(new URL("../node_modules/.bin/codex", import.meta.url)),
			githubExecutable: "gh",
		},
		sleep,
	);
	const connection = new CodexConnection(processes, sleep);
	lifecycle.register(() => connection.close());
	const exchangeStore = new ExchangeRateCacheStore(database);
	await exchangeStore.initialize();
	const exchange = new ExchangeRates(new FrankfurterClient(fetch, sleep), exchangeStore, () => new Date());
	const usage = new CodexUsageClient(
		connection,
		(turn) => costStore.save(turn),
		() => new Date(),
		async () => {
			const { localCurrency, monthlyPlanLocal } = settings.current();
			const rate = await exchange.get(localCurrency);
			return {
				localCurrency,
				monthlyPlanLocal,
				usdToLocal: rate?.rate,
				rateDate: rate?.date,
				fetchedAt: rate?.fetchedAt,
			};
		},
		() => collector.sample(),
	);
	lifecycle.register(() => usage.close());
	const agentClient = new CodexAgentClient(connection, files.realpath, randomUUID, usage);
	const settingsStore = new SettingsStore(database);
	await settingsStore.initialize();
	const settings = new SettingsService(
		settingsStore,
		options.containerGitConfig ? new GitSystemConfig(options.containerGitConfig, files) : undefined,
		access,
		() => agentClient.options(),
	);
	await settings.initialize();
	if (!lifecycle.isOpen()) return;
	const ticketStore = new TicketStore(database);
	const epicStore = new EpicStore(database);
	await epicStore.initialize();
	await ticketStore.initialize();
	const ticketHistory = new TicketHistoryStore(database);
	const identity = () => settings.gitIdentity();
	const git = options.git ?? new GitTransport(sleep, { identity });
	const githubGit = new GitTransport(sleep, {
		identity,
		githubConfigDirectory: join(config.dataDirectory, "github"),
	});
	const differences = new GitDiffClient(git);
	const repositories = new RepositoryClient(config.dataDirectory, config.importHosts, files, git);
	const projects = new ProjectService(store, repositories, access, randomUUID, () => new Date());
	const pipelineStore = new PipelineStore(database);
	await pipelineStore.initialize();
	const pipelines = new PipelineService(
		projects,
		pipelineStore,
		new GitSnapshotClient(config.dataDirectory, git, files, repositories),
		new ActProcess(dockerCommand, files, sleep, process.env["PATH"] ?? ""),
		randomUUID,
		() => new Date(),
		sleep,
	);
	lifecycle.register(() => pipelines.shutdown());
	await pipelines.recover();
	let recovery = Promise.resolve();
	lifecycle.register(async () => {
		await Promise.all([git.close(), githubGit.close()]);
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
	// Credential-home failure is reported by account APIs, without withholding project HTTP or health.
	try {
		await processes.initialize();
	} catch (err) {
		log.warn({ err }, "Account credential homes unavailable");
	}
	if (!lifecycle.isOpen()) return;
	const quotas = new QuotaStore(database, costStore);
	await quotas.initialize();
	const collector = new QuotaCollector(
		usage,
		quotas,
		() => new Date(),
		sleep,
		(err) => log.warn({ err }, "Weekly quota collection failed"),
	);
	lifecycle.register(() => collector.close());
	const cost = new CostService(access, ticketStore, costStore, usage, () => new Date(), quotas);
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
		agentClient,
		workspaces,
		projects,
		access,
		randomUUID,
		() => new Date(),
		pool,
		() => {
			const { defaultAgentModel, defaultAgentReasoningEffort } = settings.current();
			return { defaultModel: defaultAgentModel, defaultReasoningEffort: defaultAgentReasoningEffort };
		},
		() => settings.inferenceProvider(),
		ticketHistory,
	);
	lifecycle.register(() => agents.shutdown());
	const boardStore = new BoardSettingsStore(database);
	await boardStore.initialize();
	const boardSettings = new BoardSettingsService(boardStore, agents, pool, access, wakeScheduler);
	await boardSettings.initialize();
	const workflowStore = new TicketWorkflowStore(database, () => new Date());
	await workflowStore.initialize();
	collector.start();
	const workflow = new TicketWorkflowService(
		workflowStore,
		ticketStore,
		agents,
		pool,
		new WorkspaceMergeClient(workspaces, git),
		workspaces,
		new TicketPrompts(() => settings.current()),
		access,
		wakeScheduler,
		() => boardSettings.dispatchMode(),
		new AbandonedWorkspaceCleanup(terminals, workspaces),
	);
	const tickets = new TicketService(ticketStore, store, access, () => new Date(), workflow, epicStore);
	const epics = new EpicService(epicStore, ticketStore, access, () => new Date());
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
			new SettingsRouter(settings),
			agentRouter,
			new BoardSettingsRouter(boardSettings),
			new DockerRouter(docker),
			new PipelineRouter(pipelines),
			new TicketRouter(tickets, workflow, ticketHistory),
			new EpicRouter(epics),
			new CostRouter(cost),
			new WorkspaceRouter(workspaces),
			new UpstreamSyncRouter(
				new UpstreamSyncService(
					new UpstreamSyncClient(config.dataDirectory, repositories, git, githubGit),
					store,
					access,
					repositories,
				),
			),
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
