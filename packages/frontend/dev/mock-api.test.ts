import {
	accountsStatusSchema,
	projectsSchema,
	projectCostSchema,
	workspacesSchema,
	workspaceTreeSchema,
	workspaceFileSchema,
	workspaceDiffSchema,
	repositoryBranchesSchema,
	repositoryTreeSchema,
	repositoryFileSchema,
	repositoryHistorySchema,
} from "@forge/contracts";
import { agentThreadsSchema, agentViewSchema, agentOptionsSchema, agentFilesSchema } from "@forge/contracts/agents";
import {
	pullRequestsSchema,
	pullRequestSchema,
	pullRequestDiffSchema,
	pullRequestPreviewSchema,
} from "@forge/contracts/pull-requests";
import { terminalStatusSchema } from "@forge/contracts/terminal";
import { ticketsSchema, ticketSchema, ticketWorkflowSchema } from "@forge/contracts/tickets";
import { createServer, resolveConfig } from "vite";
import type { ViteDevServer } from "vite";
import { afterAll, beforeAll, expect, test } from "vitest";

let server: ViteDevServer;
let origin: string;
beforeAll(async () => {
	server = await createServer({
		mode: "mock",
		optimizeDeps: { noDiscovery: true, include: [], entries: [] },
		server: { host: "127.0.0.1", port: 5179 },
		logLevel: "silent",
	});
	await server.listen();
	origin = server.resolvedUrls!.local.at(0)!;
});
afterAll(async () => {
	await server?.close();
});
const read = async (path: string) => {
	const response = await fetch(new URL(path, origin));
	expect(response.status).toBe(200);
	expect(response.headers.get("cache-control")).toBe("no-store");
	return response.json();
};

test("mock cost data uses ticket keys from its project", async () => {
	const projects = projectsSchema.parse(await read("/api/projects"));
	for (const project of projects) {
		const tickets = ticketsSchema.parse(await read(`/api/projects/${project.id}/tickets`));
		const cost = projectCostSchema.parse(await read(`/api/projects/${project.id}/cost`));
		expect(cost.tickets.map(({ id }) => id)).toEqual(tickets.map(({ id }) => id));
		expect(cost.days).toHaveLength(30);
	}
});

test("mock chats expose isolated project history and requests while every mutation stays read-only", async () => {
	for (const project of projectsSchema.parse(await read("/api/projects"))) {
		const threads = agentThreadsSchema.parse(await read(`/api/projects/${project.id}/agents`));
		expect(threads.length).toBeGreaterThan(0);
		for (const thread of threads) {
			expect(thread.projectId).toBe(project.id);
			const path = `/api/agents/${thread.id}`;
			expect(agentOptionsSchema.parse(await read(`${path}/options`)).skills.length).toBeGreaterThan(0);
			expect(agentFilesSchema.parse(await read(`${path}/files?query=main`))).toEqual(["src/main.ts"]);
			const view = agentViewSchema.parse(await read(path));
			expect(view.items.length).toBeGreaterThan(0);
			expect(view.requests.length).toBeGreaterThan(0);
			for (const mutation of [
				`/api/projects/${project.id}/agents`,
				`${path}/messages`,
				`${path}/resume`,
				`${path}/interrupt`,
				`${path}/replies`,
			]) {
				expect((await fetch(new URL(mutation, origin), { method: "POST" })).status).toBe(405);
			}
			expect(await read(path)).toEqual(view);
		}
	}
});

test("mock boards expose project-scoped tickets across the workflow", async () => {
	const projects = projectsSchema.parse(await read("/api/projects"));
	for (const project of projects) {
		const tickets = ticketsSchema.parse(await read(`/api/projects/${project.id}/tickets`));
		expect(tickets.length).toBeGreaterThan(0);
		expect(tickets.every((ticket) => ticket.projectId === project.id)).toBe(true);
		const ticket = tickets.at(0)!;
		expect(ticketSchema.parse(await read(`/api/tickets/${ticket.id}`))).toEqual(ticket);
		for (const value of tickets) {
			expect(ticketWorkflowSchema.parse(await read(`/api/tickets/${value.id}/workflow`)).ticketId).toBe(value.id);
			expect((await fetch(new URL(`/api/tickets/${value.id}/messages`, origin), { method: "POST" })).status).toBe(
				405,
			);
		}
	}
});

test("mock projects open populated workspaces and schema-valid repository views", async () => {
	const projects = projectsSchema.parse(await read("/api/projects"));
	expect(projects.length).toBeGreaterThan(1);
	const project = projects.at(0)!;
	const workspace = workspacesSchema.parse(await read(`/api/projects/${project.id}/workspaces`)).at(0)!;
	expect(workspace.projectId).toBe(project.id);
	const tree = workspaceTreeSchema.parse(await read(`/api/workspaces/${workspace.id}/tree?path=`));
	expect(tree.entries.some((entry) => entry.kind === "directory")).toBe(true);
	const file = workspaceFileSchema.parse(await read(`/api/workspaces/${workspace.id}/file?path=README.md`));
	expect(file.content).toContain("Forge");
	workspaceDiffSchema.parse(await read(`/api/workspaces/${workspace.id}/diff`));
	const base = `/api/projects/${project.id}/repository`;
	const branches = repositoryBranchesSchema.parse(await read(`${base}/branches`));
	expect(branches.map((branch) => branch.name)).toContain("main");
	const committed = repositoryTreeSchema.parse(await read(`${base}/tree?branch=main&path=src`));
	expect(committed.entries.at(0)?.path).toBe("src/index.ts");
	repositoryFileSchema.parse(await read(`${base}/file?branch=main&path=src%2Findex.ts`));
	repositoryHistorySchema.parse(await read(`${base}/history?branch=main`));
	accountsStatusSchema.parse(await read("/api/accounts"));
	const prs = pullRequestsSchema.parse(await read(`/api/projects/${project.id}/pull-requests`));
	const pr = pullRequestSchema.parse(await read(`/api/pull-requests/${prs.at(0)!.id}`));
	const diff = pullRequestDiffSchema.parse(await read(`/api/pull-requests/${pr.id}/diff`));
	expect(diff.revision).toEqual(pr.revision);
	expect(pr.discussion.length).toBeGreaterThan(0);
	pullRequestPreviewSchema.parse(await read(`/api/workspaces/${workspace.id}/pull-request-revision`));
	expect(terminalStatusSchema.parse(await read(`/api/workspaces/${workspace.id}/terminal`))).toEqual({});
	const second = projects.at(1)!;
	const secondWorkspace = workspacesSchema.parse(await read(`/api/projects/${second.id}/workspaces`)).at(0)!;
	expect(secondWorkspace.projectId).toBe(second.id);
	expect(secondWorkspace.id).not.toBe(workspace.id);
});

test("unknown API routes and identities return JSON errors; writes cannot alter fixtures", async () => {
	for (const path of ["/api/missing", "/api/projects/unknown/workspaces", "/api/workspaces/unknown/tree"]) {
		const response = await fetch(new URL(path, origin));
		expect(response.status).toBe(404);
		expect(await response.json()).toHaveProperty("error");
	}
	const before = await read("/api/projects");
	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
		const response = await fetch(new URL("/api/projects", origin), { method });
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET, HEAD");
	}
	expect(await read("/api/projects")).toEqual(before);
	const head = await fetch(new URL("/api/projects", origin), { method: "HEAD" });
	expect(head.status).toBe(200);
	expect(await head.text()).toBe("");
});

test("mock API is opt-in and excluded from every build mode", async () => {
	for (const [command, mode] of [
		["serve", "development"],
		["build", "production"],
		["build", "mock"],
	] as const) {
		const config = await resolveConfig({ mode, logLevel: "silent" }, command);
		expect(config.plugins.some((plugin) => plugin.name === "forge-mock-api")).toBe(false);
	}
	const html = await fetch(new URL("/", origin)).then((response) => response.text());
	expect(html).toContain("Forge mock preview");
});
