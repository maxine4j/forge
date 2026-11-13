import type { Costs } from "@forge/contracts";
import type { DockerOverview } from "@forge/contracts/docker";
import { defaultForgeSettings } from "@forge/contracts/settings";
import { defaultBoardSettings } from "@forge/contracts/tickets";
import type { Plugin } from "vite";

import { costFixture, phaseFixtures } from "./cost-fixture.ts";

const date = "2026-11-02T00:00:00.000Z";
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
		this.routes.set("/api/projects", () => projects);
		this.routes.set("/api/settings", () => defaultForgeSettings);
		this.routes.set("/api/board/settings", () => defaultBoardSettings);
		this.routes.set("/api/board/docker", () => dockerOverview);
		this.routes.set("/api/accounts", () => ({
			codex: { connection: "available", account: { name: "owner@example.test" }, login: { state: "completed" } },
			github: { connection: "available", login: { state: "idle" } },
		}));
		const costData: Costs[] = [];
		const boardTickets: unknown[] = [];
		this.routes.set("/api/tickets", () => boardTickets);
		this.routes.set("/api/epics", () => []);
		this.routes.set("/api/costs", () => {
			const first = costData[0]!;
			return {
				...first,
				tickets: costData.flatMap((cost) => cost.tickets),
				totals: costFixture({ input: 328000, cached: 192000, output: 42000, turns: 16 }, 1.46, 2.34, 0.15),
				ticketEstimates: costFixture(
					{ input: 328000, cached: 192000, output: 42000, turns: 16 },
					1.46,
					2.34,
					0.15,
				),
				days: first.days.map((day) => ({
					...day,
					input: day.input * 2,
					cached: day.cached * 2,
					output: day.output * 2,
				})),
				phases: first.phases.map((phase) => ({
					...phase,
					input: phase.input * 2,
					cached: phase.cached * 2,
					output: phase.output * 2,
					turns: phase.turns * 2,
				})),
			};
		});
		for (const project of projects) {
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
			this.routes.set(`/api/agents/${agent.id}/options`, () => ({
				models: [{ id: "preview-model", name: "Codex", isDefault: true }],
				skills: [{ name: "review", description: "Review changes and check behavior" }],
			}));
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
			const tickets = [
				{
					id: `TASK-${project.id === projects.at(0)!.id ? 11 : 13}`,
					repositoryIds: [project.id],
					title: "Add keyboard navigation",
					description: "Support keyboard shortcuts.",
					status: "todo",
					agentStatus: "queued",
					createdAt: date,
				},
				{
					id: `TASK-${project.id === projects.at(0)!.id ? 12 : 14}`,
					repositoryIds: [project.id],
					title: "Improve search results",
					description: "Implement search ranking.",
					status: "in-progress",
					agentStatus: "working",
					createdAt: date,
				},
				{
					id: `TASK-${project.id === projects.at(0)!.id ? 1 : 4}`,
					repositoryIds: [],
					title: "Define the next change",
					description: "Write a small, clear scope before starting work.",
					status: "backlog",
					createdAt: date,
				},
				{
					id: `TASK-${project.id === projects.at(0)!.id ? 2 : 5}`,
					repositoryIds: [project.id],
					title: "Improve repository navigation",
					description:
						"Review the completed navigation plan. The orange card and red dot remain until the plan is approved.",
					status: "in-progress",
					needsAttention: true,
					createdAt: date,
				},
				{
					id: `TASK-${project.id === projects.at(0)!.id ? 3 : 6}`,
					repositoryIds: [project.id],
					title: "Set up the repository",
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
			boardTickets.push(...tickets.filter((ticket) => !ticket.archivedAt));
			const usage = costFixture({ input: 164000, cached: 96000, output: 21000, turns: 8 }, 0.73, 1.17, 0.075);
			const daily = Array.from({ length: 30 }, (_, index) => ({
				date: new Date(Date.parse(date) - (29 - index) * 86_400_000).toISOString().slice(0, 10),
				input: index >= 22 ? 20500 : 0,
				cached: index >= 22 ? 12000 : 0,
				output: index >= 22 ? 2625 : 0,
			}));
			const cost: Costs = {
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
				this.routes.set(`/api/tickets/${row.id}/cost`, () => ({
					since: cost.since,
					phases: row.phases,
					ticket: row,
				}));
			for (const ticket of tickets) {
				this.routes.set(`/api/tickets/${ticket.id}`, () => ticket);
				this.routes.set(`/api/tickets/${ticket.id}/model-options`, () => ({ models: [], skills: [] }));
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
					...(ticket.needsAttention
						? {
								plan: {
									revision: 1,
									text: "## Repository navigation\n\n- Keep the active section visible on mobile.\n- Preserve links to each section when the layout changes.",
								},
							}
						: {}),
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
			const value = api.read(url);
			response.statusCode = value === undefined ? 404 : 200;
			response.end(request.method === "HEAD" ? undefined : JSON.stringify(value ?? { error: "not-found" }));
		});
	},
});
