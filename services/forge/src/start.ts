import { randomInt, randomUUID } from "node:crypto";
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
import { AgentExecutionTracker } from "./agents/agent-execution-tracker.ts";
import { AgentRouter } from "./agents/agent-router.ts";
import { AgentService } from "./agents/agent-service.ts";
import { AgentThreadStore } from "./agents/agent-thread-store.ts";
import { AccessService } from "./auth/access-service.ts";
import { CodexAgentClient } from "./codex/codex-agent-client.ts";
import { CodexUsageClient } from "./codex/codex-usage-client.ts";
import { PerformanceStore } from "./codex/performance-store.ts";
import { PerformanceTelemetry } from "./codex/performance-telemetry.ts";
import { TelemetryReceiver, telemetryArguments } from "./codex/telemetry-receiver.ts";
import { releaseWorktree } from "./codex/worktree-release.ts";
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
import { modelProviderHealth } from "./model-providers/model-provider-health.ts";
import { migrateModelProviders } from "./model-providers/model-provider-migration.ts";
import { ModelProviderRouter } from "./model-providers/model-provider-router.ts";
import { ModelProviderService } from "./model-providers/model-provider-service.ts";
import { ModelProviderStore } from "./model-providers/model-provider-store.ts";
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
import { migrateTaskAgents } from "./task-agents/task-agent-migration.ts";
import { TaskAgentRouter } from "./task-agents/task-agent-router.ts";
import { TaskAgentService } from "./task-agents/task-agent-service.ts";
import { TaskAgentStore } from "./task-agents/task-agent-store.ts";
import { TerminalInventory } from "./terminal/terminal-inventory.ts";
import { TerminalProcess } from "./terminal/terminal-process.ts";
import { TerminalRouter } from "./terminal/terminal-router.ts";
import { TerminalService } from "./terminal/terminal-service.ts";
import { TerminalSocket } from "./terminal/terminal-socket.ts";
import { TerminalStore } from "./terminal/terminal-store.ts";
import { BoardSettingsRouter } from "./tickets/board-settings-router.ts";
import { BoardSettingsService } from "./tickets/board-settings-service.ts";
import { BoardSettingsStore } from "./tickets/board-settings-store.ts";
import { NotificationService } from "./tickets/notification-service.ts";
import { NotificationStore } from "./tickets/notification-store.ts";
import { migrateProviderReservations } from "./tickets/provider-reservation-migration.ts";
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
	const performanceStore = new PerformanceStore(database);
	await performanceStore.initialize();
	const performance = new PerformanceTelemetry(database, performanceStore, (threadId) =>
		performanceStore.ownsThread(threadId),
	);
	await performance.initialize();
	const telemetrySecret = randomUUID();
	const telemetryReceiver = new TelemetryReceiver(telemetrySecret, performance);
	const telemetryServer = createServer((request, response) => {
		void telemetryReceiver.handle(request, response);
	});
	const telemetryListening = new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => reject(error);
		telemetryServer.once("error", onError);
		telemetryServer.listen(0, "127.0.0.1", () => {
			telemetryServer.off("error", onError);
			resolve();
		});
	});
	lifecycle.register(async () => {
		await telemetryListening.catch(() => {});
		telemetryServer.closeAllConnections();
		if (telemetryServer.listening)
			await new Promise<void>((resolve, reject) =>
				telemetryServer.close((error) => (error ? reject(error) : resolve())),
			);
		await telemetryReceiver.close();
	});
	await telemetryListening;
	if (!lifecycle.isOpen()) return;
	telemetryServer.on("error", (error) => {
		throw error;
	});
	const telemetryAddress = telemetryServer.address();
	if (!telemetryAddress || typeof telemetryAddress === "string") throw new Error("Telemetry listener unavailable");
	const processes = new AccountProcess(
		{
			dataDirectory: config.dataDirectory,
			path: process.env["PATH"] ?? "",
			codexExecutable: fileURLToPath(new URL("../node_modules/.bin/codex", import.meta.url)),
			githubExecutable: "gh",
			codexArguments: telemetryArguments(`http://127.0.0.1:${telemetryAddress.port}`, telemetrySecret),
		},
		sleep,
	);
	const connection = new CodexConnection(processes, sleep);
	lifecycle.register(() => connection.close());
	const exchangeStore = new ExchangeRateCacheStore(database);
	await exchangeStore.initialize();
	const exchange = new ExchangeRates(new FrankfurterClient(fetch, sleep), exchangeStore, () => new Date());
	const usage: CodexUsageClient = new CodexUsageClient(
		connection,
		(turn) => costStore.save(turn),
		() => new Date(),
		async () => {
			const { localCurrency, monthlyPlanLocal } = settings.current();
			const [rate, audRate] = await Promise.all([
				exchange.get(localCurrency),
				localCurrency === "AUD" ? undefined : exchange.get("AUD"),
			]);
			return {
				localCurrency,
				monthlyPlanLocal,
				usdToLocal: rate?.rate,
				usdToAud: audRate?.rate,
				rateDate: rate?.date,
				fetchedAt: rate?.fetchedAt,
			};
		},
		() => collector.sample(),
		async (id) => (id ? (await providerStore.get(id))?.comparisonModel : undefined),
	);
	lifecycle.register(() => usage.close());
	const agentClient = new CodexAgentClient(connection, files.realpath, randomUUID, usage, {
		command: process.execPath,
		bridge: fileURLToPath(new URL("../dist/typescript-lsp/main.js", import.meta.url)),
	});
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
	const workspaceClient = new WorkspaceClient(config.dataDirectory, files, git, repositories, (path) =>
		agentClient.releaseWorktree(path, () => releaseWorktree(connection, path, sleep)),
	);
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
	const codex = new CodexAccountClient(connection, attempts);
	const github = new GithubAccountClient(processes, sleep, attempts);
	lifecycle.register(() => github.close());
	const accounts = new AccountService(access, codex, github);
	const notificationStore = new NotificationStore(database, () => new Date());
	await notificationStore.initialize();
	const agentStore = new AgentThreadStore(database, notificationStore);
	await agentStore.initialize();
	const providerStore = new ModelProviderStore(database);
	await providerStore.initialize();
	const cost = new CostService(access, ticketStore, costStore, usage, () => new Date(), quotas, providerStore);
	let wakeRequested = false;
	let schedulerWait: AbortController | undefined;
	const wakeScheduler = () => {
		wakeRequested = true;
		schedulerWait?.abort();
	};
	const serializeAdmission = <T>(operation: () => Promise<T>): Promise<T> => workflow.serialize(operation);
	const providers = new ModelProviderService(
		providerStore,
		access,
		randomUUID,
		(provider) => agentClient.options(undefined, provider),
		serializeAdmission,
		wakeScheduler,
		modelProviderHealth(
			fetch,
			() => agentClient.options(undefined, { kind: "openai" }),
			() => usage.quotaExhausted(),
			sleep,
		),
	);
	const tracker = new AgentExecutionTracker(wakeScheduler);
	const agents = new AgentService(
		agentStore,
		agentClient,
		workspaces,
		projects,
		access,
		randomUUID,
		() => new Date(),
		tracker,
		undefined,
		ticketHistory,
		performance,
		true,
	);
	lifecycle.register(() => agents.shutdown());
	const boardStore = new BoardSettingsStore(database);
	await boardStore.initialize();
	const boardSettings = new BoardSettingsService(boardStore, agents, access, wakeScheduler);
	await boardSettings.initialize();
	const workflowStore = new TicketWorkflowStore(database, () => new Date(), notificationStore);
	await workflowStore.initialize();
	await migrateModelProviders(database, randomUUID, !!(await codex.status()).account);
	const taskAgentStore = new TaskAgentStore(database);
	await taskAgentStore.initialize();
	await migrateTaskAgents(database, randomUUID);
	await migrateProviderReservations(database);
	await agentStore.recover();
	const taskAgents = new TaskAgentService(
		taskAgentStore,
		providers,
		access,
		randomUUID,
		randomInt,
		serializeAdmission,
		wakeScheduler,
	);
	collector.start();
	const workflow = new TicketWorkflowService(
		workflowStore,
		ticketStore,
		agents,
		new WorkspaceMergeClient(workspaces, git),
		workspaces,
		new TicketPrompts(() => settings.current()),
		access,
		wakeScheduler,
		() => boardSettings.dispatchMode(),
		new AbandonedWorkspaceCleanup(terminals, workspaces),
		providers,
		taskAgents,
		() => usage.quotaExhausted(),
	);
	const tickets = new TicketService(ticketStore, store, access, () => new Date(), workflow, epicStore);
	const epics = new EpicService(epicStore, ticketStore, access, () => new Date());
	const notifications = new NotificationService(notificationStore, tickets, epicStore, agentStore, access);
	await notifications.initialize();
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
	const assets = new StaticAssets(fileURLToPath(new URL("../../forge-web/dist", import.meta.url)), files);
	if (!(await assets.read("/"))) throw new Error("Build Forge frontend before starting the application");
	if (!lifecycle.isOpen()) return;
	const app = new HttpApplication(new ProjectRouter(projects), access).create(
		[
			new AccountRouter(accounts),
			new SettingsRouter(settings),
			new ModelProviderRouter(providers),
			new TaskAgentRouter(taskAgents),
			agentRouter,
			new BoardSettingsRouter(boardSettings),
			new DockerRouter(docker),
			new PipelineRouter(pipelines),
			new TicketRouter(tickets, workflow, ticketHistory, notifications),
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
