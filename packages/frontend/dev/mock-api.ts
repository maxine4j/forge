import type { Plugin } from "vite";

const date = "2026-11-02T00:00:00.000Z";
const head = "a".repeat(40);
const baseSha = "b".repeat(40);
const commit = { sha: head, subject: "Improve project navigation", author: "Owner", date };
const empty = { files: [], patch: "", truncated: false };
const change = {
	files: [{ path: "src/index.ts", binary: false }],
	patch: "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-export const greeting = 'Hello';\n+export const greeting = 'Hello, Forge';\n",
	truncated: false,
};
const revision = { baseSha, head, mergeBase: baseSha };
const files: Record<string, string> = {
	"README.md":
		"# Forge\n\nA workspace for building your next project.\n\n## Development\n\nRun `pnpm dev` to start the application.\n",
	"package.json": '{\n  "name": "forge-demo",\n  "private": true,\n  "scripts": { "dev": "vite" }\n}\n',
	"src/index.ts": "export const greeting = 'Hello, Forge';\n",
	"src/style.css": "body {\n  margin: 0;\n  font-family: system-ui, sans-serif;\n}\n",
};
const projects = [
	{ id: "123e4567-e89b-42d3-a456-426614174000", name: "Forge", status: "ready", createdAt: date },
	{ id: "123e4567-e89b-42d3-a456-426614174010", name: "Homelab dashboard", status: "ready", createdAt: date },
];

export interface IMockApi {
	/** Returns a deterministic fixture, or undefined for an unknown route or query. */
	read(url: URL): unknown;
}

class MockApi implements IMockApi {
	private readonly routes = new Map<string, (url: URL) => unknown>();

	constructor() {
		this.routes.set("/api/projects", () => projects);
		this.routes.set("/api/accounts", () => ({
			codex: { connection: "available", account: { name: "owner@example.test" }, login: { state: "completed" } },
			github: { connection: "available", login: { state: "idle" } },
		}));
		for (const project of projects) {
			const id = project.id.replace(/0$/, "1");
			const prId = project.id.replace(/0$/, "2");
			const workspace = {
				id,
				projectId: project.id,
				name: "Project files",
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
				title: "Improve project navigation",
				body: "Simplify browsing files and reviewing changes.",
				status: "open",
				createdAt: date,
			};
			const projectRoot = `/api/projects/${project.id}`;
			const agent = {
				id: project.id.replace(/0$/, "5"),
				projectId: project.id,
				workspaceId: project.id.replace(/0$/, "6"),
				title: "Review project navigation",
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
						text: "Read application routing and project navigation.",
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
					id: `FORGE-${project.id === projects.at(0)!.id ? 1 : 4}`,
					projectId: project.id,
					title: "Define the next change",
					description: "Write a small, clear scope before starting work.",
					status: "backlog",
					createdAt: date,
				},
				{
					id: `FORGE-${project.id === projects.at(0)!.id ? 2 : 5}`,
					projectId: project.id,
					title: "Improve project navigation",
					description: "Make the project easier to browse on every screen.",
					status: "in-progress",
					createdAt: date,
				},
				{
					id: `FORGE-${project.id === projects.at(0)!.id ? 3 : 6}`,
					projectId: project.id,
					title: "Set up the project",
					description: "Create the initial repository.",
					status: "done",
					createdAt: date,
				},
			];
			this.routes.set(`${projectRoot}/tickets`, () => tickets);
			for (const ticket of tickets) {
				this.routes.set(`/api/tickets/${ticket.id}`, () => ticket);
				this.routes.set(`/api/tickets/${ticket.id}/workflow`, () => ({
					ticketId: ticket.id,
					phase: ticket.status === "backlog" ? "planning" : "implementation",
					state: "idle",
					mergeAttempts: 0,
					run: 0,
				}));
			}
			const workspaceRoot = `/api/workspaces/${id}`;
			const repositoryRoot = `${projectRoot}/repository`;
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
	transformIndexHtml: () => [
		{
			tag: "div",
			attrs: {
				role: "status",
				style: "padding:8px;text-align:center;background:#243344;color:#fff;font:14px system-ui",
			},
			children: "Forge mock preview · Read-only fixtures · No backend or shell execution",
			injectTo: "body-prepend",
		},
	],
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
