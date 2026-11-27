import { costRangeSchema, defaultCostRange, type Costs } from "@forge/contracts";
import type { AgentView } from "@forge/contracts/agents";
import type { DockerOverview } from "@forge/contracts/docker";
import { defaultForgeSettings } from "@forge/contracts/settings";
import { defaultBoardSettings, type EpicDetail, type Ticket } from "@forge/contracts/tickets";
import type { Plugin } from "vite";

import { costFixture, phaseFixtures } from "./cost-fixture.ts";
import { historyFixture } from "./history-fixture.ts";

const date = "2026-11-02T00:00:00.000Z";
const costCutoff = (url: URL) => {
	const range = costRangeSchema.safeParse(url.searchParams.get("range")).data ?? defaultCostRange;
	return Date.parse(date) + Number.parseInt(range, 10) * (range.endsWith("hr") ? 3_600_000 : 86_400_000);
};
const previewUsage = (turns: number) =>
	costFixture(
		{ input: 20500 * turns, cached: 12000 * turns, output: 2624 * turns, turns },
		(0.73 * turns) / 8,
		(1.17 * turns) / 8,
		(0.075 * turns) / 8,
	);
const previewProviders = (usage: ReturnType<typeof previewUsage>): Pick<Costs, "providers" | "providerTotals"> => {
	const { input, cached, output, turns, localCurrencies } = usage;
	const openai = {
		input,
		cached,
		output,
		turns,
		apiAud: localCurrencies.at(0)?.api ?? 0,
		incomplete: 0,
		incompleteTokens: 0,
	};
	const ollama = {
		input: 0,
		cached: 0,
		output: 0,
		turns: 0,
		apiAud: 0,
		incomplete: 0,
		incompleteTokens: 0,
		weeklySavedPercent: 0,
		incompleteWeekly: 0,
	};
	return {
		providerTotals: { openai, ollama },
		providers: [
			{
				id: "123e4567-e89b-42d3-a456-426614174099",
				name: "OpenAI",
				kind: "openai",
				current: true,
				workSharePercent: turns ? 100 : 0,
				...openai,
			},
			{
				id: "123e4567-e89b-42d3-a456-426614174098",
				name: "Local Ollama",
				kind: "ollama",
				workSharePercent: 0,
				...ollama,
			},
		],
	};
};
const previewDays = (days: Costs["days"], cutoff: number): Costs["days"] =>
	days
		.filter(
			(day) =>
				Date.parse(day.date)
				>= new Date(Math.max(Date.parse(days.at(0)!.date), cutoff)).setUTCHours(0, 0, 0, 0),
		)
		.map((day) => (Date.parse(day.date) < cutoff ? { ...day, input: 0, cached: 0, output: 0 } : day));
const head = "a".repeat(40);
const baseSha = "b".repeat(40);
const commit = { sha: head, subject: "Improve repository navigation", author: "Owner", date };
const empty = { files: [], patch: "", truncated: false };
const change = {
	files: [{ path: "src/index.ts", binary: false }],
	patch: "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const greeting = 'Hello';\n+export const greeting = 'Hello, Forge';\n",
	truncated: false,
};
const revision = { baseSha, head, mergeBase: baseSha };
const files: Record<string, string> = {
	"README.md":
		"# Forge\n\nA workspace for building your next repository.\n\n## Development\n\nRun `pnpm dev` to start the application.\n",
	"package.json": '{\n  "name": "forge-demo",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}\n',
	"src/index.ts": "export const greeting = 'Hello, Forge';\n",
	"src/style.css": "body {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n}\n",
};
const projects = [
	{
		id: "123e4567-e89b-42d3-a456-426614174000",
		name: "Forge",
		status: "ready",
		createdAt: date,
		upstreamSyncAvailable: true,
	},
	{ id: "123e4567-e89b-42d3-a456-426614174010", name: "Homelab dashboard", status: "ready", createdAt: date },
];
const epics = [
	{
		id: "EPIC-1",
		title: "Repository experience",
		description: "Improve how people browse and navigate repositories.",
	},
	{ id: "EPIC-2", title: "Dashboard foundations", description: "Build the first set of Homelab dashboard features." },
];
const navigationPlan = {
	revision: 1,
	text: "## Repository navigation\n\n- Keep the active section visible on mobile.\n- Preserve links to each section when the layout changes.",
};
const searchPlan = {
	revision: 1,
	text: "## Search ranking\n\nRank exact title matches first, followed by title prefixes and description matches. Break ties by title and then ticket key.\n\n1. Normalize the query and searchable fields for case-insensitive matching.\n2. Preserve the existing filters and empty-query ordering.\n3. Verify match order, ties, and queries with no results.",
};
const dockerOverview: DockerOverview = {
	available: true,
	statisticsAt: date,
	statisticsStale: false,
	operation: null,
	containers: [
		{
			id: "d1".repeat(32),
			name: "forge-preview-web",
			image: "node:24-alpine",
			status: "Up 8 minutes",
			ports: "5173/tcp",
			stats: {
				cpu: "1.24%",
				memory: "128 MiB / 2 GiB",
				network: "840 kB / 1.2 MB",
				block: "16 MB / 4 MB",
				processes: "12",
			},
		},
		{
			id: "d2".repeat(32),
			name: "forge-preview-db",
			image: "postgres:17-alpine",
			status: "Up 8 minutes",
			ports: "5432/tcp",
			stats: {
				cpu: "0.08%",
				memory: "64 MiB / 2 GiB",
				network: "210 kB / 96 kB",
				block: "8 MB / 2 MB",
				processes: "7",
			},
		},
	],
};

export interface IMockApi {
	/** Returns a deterministic fixture, or undefined for an unknown route or query. */
	read(url: URL): unknown;
}

export class MockApi implements IMockApi {
	private readonly routes = new Map<string, (url: URL) => unknown>();

	constructor() {
		const planner = { name: "Planner", avatarColour: "Sky", avatarSymbol: "Robot" } as const;
		const implementer = { name: "Local implementer", avatarColour: "Mint", avatarSymbol: "Terminal" } as const;
		this.routes.set("/api/projects", () => projects);
		this.routes.set("/api/settings", () => defaultForgeSettings);
		this.routes.set("/api/tickets/agent-metrics", () => ({ providers: [], agents: [] }));
		this.routes.set("/api/model-providers/health", () => [
			{ providerId: "123e4567-e89b-42d3-a456-426614174099", status: "healthy" },
			{ providerId: "123e4567-e89b-42d3-a456-426614174098", status: "healthy" },
		]);
		this.routes.set("/api/model-providers", () => [
			{
				id: "123e4567-e89b-42d3-a456-426614174099",
				name: "OpenAI",
				kind: "openai",
				retired: false,
				maxConcurrentAgents: 1,
			},
			{
				id: "123e4567-e89b-42d3-a456-426614174098",
				name: "Local Ollama",
				kind: "ollama",
				retired: false,
				maxConcurrentAgents: 1,
				endpoint: "http://ollama/v1",
				comparisonModel: "gpt-5.4",
			},
		]);
		this.routes.set("/api/task-agents", () => [
			{
				id: "123e4567-e89b-42d3-a456-426614174090",
				...planner,
				models: [
					{
						providerId: "123e4567-e89b-42d3-a456-426614174099",
						model: "preview-model",
						reasoningEffort: "high",
					},
					{ providerId: "123e4567-e89b-42d3-a456-426614174098", model: "local:latest" },
					{ providerId: "123e4567-e89b-42d3-a456-426614174098", model: "local:backup" },
				],
				retired: false,
			},
			{
				id: "123e4567-e89b-42d3-a456-426614174091",
				...implementer,
				models: [{ providerId: "123e4567-e89b-42d3-a456-426614174098", model: "local:latest" }],
				retired: false,
			},
		]);
		this.routes.set("/api/board/settings", () => defaultBoardSettings);
		this.routes.set("/api/board/docker", () => dockerOverview);
		this.routes.set("/api/accounts", () => ({
			codex: { connection: "available", account: { name: "owner@example.test" }, login: { state: "completed" } },
			github: { connection: "available", login: { state: "idle" } },
		}));
		const costData: Costs[] = [];
		const boardTickets: Ticket[] = [];
		this.routes.set("/api/tickets/notifications", () =>
			boardTickets
				.filter((ticket) => ticket.needsAttention)
				.map((ticket) => ({
					id: `plan-${ticket.id}`,
					at: date,
					kind: "plan",
					ticket,
					epic: { ...epics.find((epic) => epic.id === ticket.epicId)!, createdAt: date },
					workflow: this.routes.get(`/api/tickets/${ticket.id}/workflow`)!(new URL("http://localhost")),
				})),
		);
		this.routes.set("/api/tickets", (url) =>
			boardTickets.filter((ticket) => url.searchParams.get("includeArchived") === "true" || !ticket.archivedAt),
		);
		this.routes.set("/api/costs", (url) => {
			const first = costData[0]!;
			const cutoff = costCutoff(url);
			const days = previewDays(first.days, cutoff);
			const turnCount = days.filter((day) => day.input > 0).length;
			const totals = previewUsage(turnCount * costData.length);
			const chats = previewUsage(turnCount);
			const account = previewUsage(totals.turns + chats.turns);
			const turnsPerDay = costData.length + 1;
			const hourly = Date.parse(date) - cutoff <= 86_400_000 && url.searchParams.get("range")?.endsWith("hr");
			const weeklyBudget = first.weeklyBudget;
			return {
				...first,
				tickets: costData.flatMap((cost) =>
					cost.tickets.map((row) => {
						const summary = previewUsage(row.turns ? turnCount : 0);
						return { ...row, ...summary, phases: phaseFixtures(summary) };
					}),
				),
				...previewProviders(account),
				totals: account,
				chats,
				ticketEstimates: totals,
				days: days.map((day) => ({
					...day,
					input: day.input * turnsPerDay,
					cached: day.cached * turnsPerDay,
					output: day.output * turnsPerDay,
				})),
				hours: hourly
					? Array.from({ length: (Date.parse(date) - cutoff) / 3_600_000 + 1 }, (_, index) => {
							const start = new Date(cutoff + index * 3_600_000).toISOString();
							const { input, cached, output } = previewUsage(start === date ? turnsPerDay : 0);
							return { date: start, input, cached, output };
						})
					: undefined,
				phases: [...phaseFixtures(totals), { ...chats, phase: "chat" }],
				quotaAttribution: [
					{
						bucketId: "codex",
						consumption: (2 * totals.turns) / 8,
						allocated: totals.weeklyUsagePercent,
						unallocated: (0.83 * totals.turns) / 8,
					},
				],
				weeklyBudget: weeklyBudget && {
					...weeklyBudget,
					buckets: weeklyBudget.buckets.map((bucket) => ({
						...bucket,
						observations: bucket.observations.filter((entry) => Date.parse(entry.observedAt) >= cutoff),
						...(hourly && cutoff > Date.parse(date) - 86_400_000
							? {
									additionalTickets: undefined,
									unavailable: "learning",
									completedTickets: 0,
									coverageHours: (Date.parse(date) - cutoff) / 3_600_000,
									consumption: 0,
									periodStart: undefined,
									periodEnd: undefined,
								}
							: {}),
					})),
				},
			};
		});
		for (const [projectIndex, project] of projects.entries()) {
			const epicId = epics[projectIndex]!.id;
			const id = project.id.replace(/0$/, "1");
			const prId = project.id.replace(/0$/, "2");
			const workspace = {
				id,
				projectId: project.id,
				name: "Repository files",
				branch: `forge/workspace/${id}`,
				head,
				baseSha,
				status: "ready",
				createdAt: date,
			};
			const pr = {
				id: prId,
				projectId: project.id,
				workspaceId: id,
				branch: workspace.branch,
				base: "main",
				title: "Improve repository navigation",
				body: "Simplify browsing files and reviewing changes.",
				status: "open",
				createdAt: date,
			};
			const projectRoot = `/api/projects/${project.id}`;
			const agent = {
				id: project.id.replace(/0$/, "5"),
				projectId: project.id,
				workspaceId: project.id.replace(/0$/, "6"),
				title: "Review repository navigation",
				createdAt: date,
				status: "waiting",
			};
			this.routes.set(`${projectRoot}/agents`, () => [agent]);
			const agentOptions = () => ({
				models: [
					{
						id: "preview-model",
						name: "Codex",
						isDefault: true,
						defaultReasoningEffort: "medium",
						supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({
							reasoningEffort,
							description: reasoningEffort,
						})),
					},
				],
				skills: [{ name: "review", description: "Review changes and check behavior" }],
			});
			this.routes.set("/api/model-providers/123e4567-e89b-42d3-a456-426614174099/model-options", agentOptions);
			this.routes.set("/api/model-providers/123e4567-e89b-42d3-a456-426614174098/model-options", () => ({
				models: [{ id: "local:latest", name: "local:latest", isDefault: true }],
				skills: [],
				defaultModel: "local:latest",
				supportsAutoReview: false,
			}));
			this.routes.set(`/api/agents/${agent.id}/options`, agentOptions);
			this.routes.set(`/api/agents/${agent.id}/files`, () => ["src/main.ts"]);
			this.routes.set(`/api/agents/${agent.id}`, () => ({
				thread: agent,
				items: [
					{ id: "user", role: "user", text: "Review the navigation and suggest a small improvement." },
					{
						id: "activity",
						role: "activity",
						title: "git status --short",
						status: "completed",
						text: "Working tree clean",
					},
					{
						id: "read",
						role: "activity",
						title: "Read src/main.ts",
						status: "completed",
						text: "Read application routing and repository navigation.",
					},
					{
						id: "answer",
						role: "assistant",
						text: "The project sections are clear. I can improve the mobile layout and verify it in the browser.",
					},
				],
				requests: [
					{
						id: "preview-question",
						kind: "input",
						description: "Choose the next step",
						questions: [
							{
								id: "scope",
								question: "Which scope should I use?",
								secret: false,
								options: ["Mobile navigation", "All navigation"],
							},
						],
					},
				],
				truncated: false,
			}));
			const tickets: Ticket[] = [
				{
					id: `TASK-${project.id === projects.at(0)!.id ? 11 : 13}`,
					repositoryIds: [project.id],
					title: "Add keyboard navigation",
					epicId,
					description: "Support keyboard shortcuts.",
					status: "todo",
					agentStatus: "queued",
					assignee: planner,
					createdAt: date,
				},
				{
					id: `TASK-${project.id === projects.at(0)!.id ? 12 : 14}`,
					repositoryIds: [project.id],
					title: "Improve search results",
					description: "Implement search ranking.",
					status: "in-progress",
					agentStatus: "working",
					assignee: planner,
					createdAt: date,
				},
				{
					id: `TASK-${project.id === projects.at(0)!.id ? 1 : 4}`,
					repositoryIds: [],
					title: "Define the next change",
					epicId,
					description: "Write a small, clear scope before starting work.",
					status: "backlog",
					createdAt: date,
				},
				{
					id: `TASK-${project.id === projects.at(0)!.id ? 2 : 5}`,
					repositoryIds: [project.id],
					title: "Improve repository navigation",
					epicId,
					description:
						"Review the completed navigation plan. The orange card and notification dot remain until the plan is approved.",
					status: "in-progress",
					needsAttention: true,
					assignee: planner,
					createdAt: date,
				},
				{
					id: `TASK-${project.id === projects.at(0)!.id ? 3 : 6}`,
					repositoryIds: [project.id],
					title: "Set up the repository",
					epicId,
					description: "Create the initial repository.",
					status: "done",
					createdAt: date,
				},
				{
					id: `TASK-${project.id === projects.at(0)!.id ? 7 : 8}`,
					repositoryIds: [project.id],
					title: "Explore initial requirements",
					description: "Capture requirements for the first release.",
					status: "done",
					createdAt: date,
					archivedAt: date,
				},
			];
			boardTickets.push(...tickets);
			const usage = previewUsage(8);
			const daily = Array.from({ length: 30 }, (_, index) => ({
				date: new Date(Date.parse(date) - (29 - index) * 86_400_000).toISOString().slice(0, 10),
				input: index >= 22 ? 20500 : 0,
				cached: index >= 22 ? 12000 : 0,
				output: index >= 22 ? 2624 : 0,
			}));
			const cost: Costs = {
				...previewProviders(usage),
				ticketEstimates: usage,
				chats: costFixture({ input: 0, cached: 0, output: 0, turns: 0 }),
				quotaAttribution: [{ bucketId: "codex", consumption: 2, allocated: 1.17, unallocated: 0.83 }],
				weeklyBudget: {
					defaultBucketId: "codex",
					buckets: [
						{
							bucketId: "codex",
							bucket: "Codex",
							remainingPercent: 40,
							lastObservedAt: date,
							resetsAt: new Date(Date.parse(date) + 86_400_000).toISOString(),
							fresh: true,
							additionalTickets: 8,
							completedTickets: 3,
							coverageHours: 24,
							consumption: 15,
							periodStart: new Date(Date.parse(date) - 86_400_000).toISOString(),
							periodEnd: date,
							observations: Array.from({ length: 289 }, (_, index) => ({
								bucketId: "codex",
								bucket: "Codex",
								minutes: 10080,
								observedAt: new Date(Date.parse(date) - (288 - index) * 300_000).toISOString(),
								usedPercent: 45 + (index * 15) / 288,
								resetsAt: new Date(Date.parse(date) + 86_400_000).toISOString(),
							})),
						},
					],
				},
				since: `${daily.at(0)!.date}T00:00:00.000Z`,
				totals: usage,
				days: daily,
				phases: phaseFixtures(usage),
				tickets: tickets.map(({ id, title, archivedAt }, index) => {
					const summary = index === 1 ? usage : costFixture({ input: 0, cached: 0, output: 0, turns: 0 });
					return { id, title, archivedAt, ...summary, phases: phaseFixtures(summary) };
				}),
				limits: {
					plan: "plus",
					windows: [
						{ bucket: "Codex", minutes: 300, usedPercent: 37 },
						{ bucket: "Codex", minutes: 10080, usedPercent: 64 },
					],
				},
			};
			costData.push(cost);
			for (const row of cost.tickets)
				this.routes.set(`/api/tickets/${row.id}/cost`, (url) => {
					const summary = previewUsage(
						row.turns ? previewDays(daily, costCutoff(url)).filter((day) => day.input > 0).length : 0,
					);
					return { since: cost.since, phases: phaseFixtures(summary), ticket: summary };
				});
			for (const ticket of tickets) {
				this.routes.set(`/api/tickets/${ticket.id}/history`, (url) => {
					const history = historyFixture(ticket.id, ticket.status);
					return {
						...history,
						events: history.events.filter((event) => event.id > Number(url.searchParams.get("after") ?? 0)),
					};
				});
				const working = ticket.agentStatus === "working";
				const plannerId = ticket.needsAttention
					? project.id.replace(/0$/, "7")
					: working
						? project.id.replace(/0$/, "8")
						: undefined;
				if (plannerId) {
					const conversation: AgentView = {
						thread: {
							id: plannerId,
							projectId: project.id,
							workspaceId: id,
							title: ticket.title,
							createdAt: date,
							status: working ? "running" : "idle",
						},
						items: working
							? [
									{
										id: "scope",
										role: "user",
										text: "Improve search ranking so exact title matches appear first.",
									},
									{
										id: "inspect",
										role: "activity",
										title: "Inspect search ranking",
										status: "completed",
										text: "Reviewed the existing search and filtering behavior.",
									},
									{
										id: "update",
										role: "assistant",
										text: "I’m checking the ranking rules and will preserve the existing filters.",
									},
									{
										id: "work",
										role: "activity",
										title: "Review search tests",
										status: "running",
										text: "Checking ranking and filter coverage.",
									},
								]
							: [
									{
										id: "scope",
										role: "user",
										text: "Make repository navigation easier to use on smaller screens.",
									},
									{
										id: "inspect",
										role: "activity",
										title: "Read repository navigation",
										status: "completed",
										text: "Reviewed the repository tabs and their links at desktop and mobile widths.",
									},
									{
										id: "findings",
										role: "assistant",
										text: "The tabs can overflow on narrow screens. I’ll keep the active tab in view and preserve links to each section.",
									},
									{ id: "plan", role: "assistant", kind: "plan", text: navigationPlan.text },
								],
						requests: [],
						truncated: false,
						contextWindow: { used: 8200, max: 128000 },
					};
					this.routes.set(`/api/agents/${plannerId}`, () => conversation);
					this.routes.set(`/api/agents/${plannerId}/options`, agentOptions);
					this.routes.set(`/api/agents/${plannerId}/files`, () => Object.keys(files));
				}
				ticket.executionSettings = {
					plannerAgentId: "123e4567-e89b-42d3-a456-426614174090",
					implementerAgentId: "123e4567-e89b-42d3-a456-426614174091",
					...ticket.executionSettings,
				};
				this.routes.set(`/api/tickets/${ticket.id}`, () => ticket);
				this.routes.set(`/api/tickets/${ticket.id}/model-options`, agentOptions);
				this.routes.set(`/api/tickets/${ticket.id}/workflow`, () => ({
					ticketId: ticket.id,
					phase: ticket.status === "done" ? "implementation" : "planning",
					state:
						ticket.agentStatus === "queued"
							? "queued"
							: ticket.agentStatus === "working"
								? "running"
								: "idle",
					mergeAttempts: 0,
					plannerId,
					plan: ticket.needsAttention ? navigationPlan : working ? searchPlan : undefined,
				}));
			}
			const workspaceRoot = `/api/workspaces/${id}`;
			const repositoryRoot = `${projectRoot}/repository`;
			const commitFiles = [
				{ path: "src/index.ts", status: "M", additions: 2, deletions: 1, binary: false },
				{
					path: "src/theme.css",
					oldPath: "src/style.css",
					status: "R",
					additions: 1,
					deletions: 1,
					binary: false,
				},
				{ path: "assets/logo.bin", status: "A", additions: 0, deletions: 0, binary: true },
				{
					path: "scripts/check.sh",
					status: "M",
					additions: 0,
					deletions: 0,
					binary: false,
					oldMode: "100644",
					newMode: "100755",
				},
			];
			for (const sha of [head, baseSha]) {
				this.routes.set(`${repositoryRoot}/commits/${sha}`, () => ({
					...commit,
					sha,
					subject: sha === head ? commit.subject : "Initialize project",
					message:
						sha === head
							? `${commit.subject}\n\nKeep navigation consistent across desktop and mobile.\nRetain editor drafts while reviewing commits.`
							: "Initialize project",
					parents: sha === head ? [baseSha] : [],
					base: sha === head ? baseSha : null,
					files: commitFiles,
					additions: 3,
					deletions: 2,
					truncated: false,
				}));
				this.routes.set(`${repositoryRoot}/commits/${sha}/diff`, (url) => {
					const file = commitFiles.find((file) => file.path === url.searchParams.get("path"));
					if (!file || ![null, "true", "false"].includes(url.searchParams.get("ignoreWhitespace")))
						return undefined;
					const hidden = url.searchParams.get("ignoreWhitespace") === "true" && file.status === "R";
					return {
						path: file.path,
						status: file.status,
						binary: file.binary,
						oldMode: file.oldMode,
						newMode: file.newMode,
						submodule: false,
						truncated: false,
						additions: hidden ? 0 : file.additions,
						deletions: hidden ? 0 : file.deletions,
						hunks:
							file.additions && !hidden
								? [
										{
											header: "@@ -1 +1,2 @@",
											lines: [
												{ kind: "deletion", text: "export const greeting = 'Hello';", old: 1 },
												{
													kind: "addition",
													text: "export const greeting = 'Hello, Forge';",
													new: 1,
												},
												{ kind: "addition", text: "export const navigation = 'Code';", new: 2 },
											],
										},
									]
								: [],
					};
				});
			}
			this.routes.set(`${repositoryRoot}/upstream-sync`, () =>
				project.upstreamSyncAvailable
					? { state: "ready", branch: "main", ahead: 2, behind: 1 }
					: { state: "unconfigured" },
			);
			this.routes.set(projectRoot, () => project);
			this.routes.set(`${projectRoot}/workspaces`, () => [workspace]);
			this.routes.set(`${repositoryRoot}/branches`, () => [
				{ name: "main", sha: head },
				{ name: "feature/navigation", sha: baseSha },
			]);
			this.routes.set(`${repositoryRoot}/tree`, (url) => this.tree(url, true));
			this.routes.set(`${repositoryRoot}/file`, (url) => this.file(url, true));
			this.routes.set(`${repositoryRoot}/history`, (url) =>
				this.validBranch(url)
					? {
							head,
							commits: [
								commit,
								{
									sha: baseSha,
									subject: "Initialize project",
									author: "Owner",
									date: "2026-11-01T00:00:00.000Z",
								},
							],
							hasMore: false,
						}
					: undefined,
			);
			this.routes.set(`${workspaceRoot}/tree`, (url) => this.tree(url, false));
			this.routes.set(`${workspaceRoot}/file`, (url) => this.file(url, false));
			this.routes.set(`${workspaceRoot}/diff`, () => ({
				comparison: "merge-base(main, workspace)..workspace",
				head,
				baseSha,
				branch: change,
				staged: empty,
				unstaged: change,
				untracked: empty,
			}));
			this.routes.set(`${workspaceRoot}/terminal`, () => ({}));
			this.routes.set(`${workspaceRoot}/pull-request-revision`, () => ({ revision, hasChanges: true }));
			this.routes.set(`${projectRoot}/pull-requests`, () => [pr]);
			this.routes.set(`/api/pull-requests/${prId}`, () => ({
				...pr,
				revision,
				approval: "none",
				discussion: [
					{
						id: project.id.replace(/0$/, "3"),
						pullRequestId: prId,
						kind: "comment",
						body: "Ready for a first review.",
						revision,
						createdAt: date,
					},
				],
			}));
			this.routes.set(`/api/pull-requests/${prId}/diff`, () => ({
				comparison: "merge-base(main, workspace)..workspace (committed)",
				revision,
				diff: change,
			}));
		}
		const summaries = epics.map((epic) => {
			const children = boardTickets.filter((ticket) => !ticket.archivedAt && ticket.epicId === epic.id);
			const counts = { backlog: 0, todo: 0, "in-progress": 0, done: 0 };
			for (const child of children) counts[child.status]++;
			const summary = {
				...epic,
				createdAt: date,
				counts,
				total: children.length,
				done: counts.done,
				complete: children.length > 0 && counts.done === children.length,
			};
			const detail: EpicDetail = { ...summary, children };
			this.routes.set(`/api/epics/${epic.id}`, () => detail);
			return summary;
		});
		this.routes.set("/api/epics", () => summaries);
	}

	read(url: URL): unknown {
		return this.routes.get(url.pathname)?.(url);
	}

	private validBranch(url: URL): boolean {
		return ["main", "feature/navigation"].includes(url.searchParams.get("branch") ?? "main");
	}

	private tree(url: URL, committed: boolean): unknown {
		if (committed && !this.validBranch(url)) return undefined;
		const path = url.searchParams.get("path") ?? "";
		if (path !== "" && path !== "src") return undefined;
		const entries =
			path === ""
				? [
						{ name: "src", path: "src", kind: "directory" },
						{ name: "README.md", path: "README.md", kind: "file" },
						{ name: "package.json", path: "package.json", kind: "file" },
					]
				: [
						{ name: "index.ts", path: "src/index.ts", kind: "file" },
						{ name: "style.css", path: "src/style.css", kind: "file" },
					];
		return {
			path,
			...(committed ? { head } : {}),
			entries: entries.map((entry) => ({
				...entry,
				...(committed ? { lastCommit: commit } : { lastChangedAt: date }),
			})),
			truncated: false,
		};
	}

	private file(url: URL, committed: boolean): unknown {
		if (committed && !this.validBranch(url)) return undefined;
		const path = url.searchParams.get("path") ?? "";
		if (!Object.hasOwn(files, path)) return undefined;
		return { path, content: files[path], ...(committed ? {} : { version: "1".repeat(64) }) };
	}
}

export const mockApi = (): Plugin => ({
	name: "forge-mock-api",
	apply: "serve",
	configureServer(server) {
		const api = new MockApi();
		server.middlewares.use((request, response, next) => {
			const url = new URL(request.url ?? "/", "http://forge.test");
			if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return next();
			response.setHeader("Content-Type", "application/json");
			response.setHeader("Cache-Control", "no-store");
			response.setHeader("X-Forge-Mock", "read-only");
			if (request.method !== "GET" && request.method !== "HEAD") {
				response.statusCode = 405;
				response.setHeader("Allow", "GET, HEAD");
				response.end(JSON.stringify({ error: "mock-read-only" }));
				return;
			}
			if (/^\/api\/agents\/[^/]+\/events$/u.test(url.pathname)) {
				const agentUrl = new URL(url.pathname.slice(0, -"/events".length), url);
				if (api.read(agentUrl)) {
					response.setHeader("Content-Type", "text/event-stream");
					if (request.method === "HEAD") response.end();
					else response.write(": connected\n\n");
					return;
				}
			}
			const value = api.read(url);
			response.statusCode = value === undefined ? 404 : 200;
			response.end(request.method === "HEAD" ? undefined : JSON.stringify(value ?? { error: "not-found" }));
		});
	},
});
