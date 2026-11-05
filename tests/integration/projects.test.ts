import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { afterEach, expect, test } from "vitest";

import { AccessService } from "../../src/auth/access-service.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { HttpApplication } from "../../src/http/http-application.ts";
import { ProjectRouter } from "../../src/projects/project-router.ts";
import { ProjectService } from "../../src/projects/project-service.ts";
import { ProjectStore } from "../../src/projects/project-store.ts";
import { GitTransport } from "../../src/repositories/git-transport.ts";
import { RepositoryClient } from "../../src/repositories/repository-client.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const headers = { "x-webauth-user": "owner", origin: "https://forge.example.com", "content-type": "application/json" };
const closeServer = (server: Server) =>
	new Promise<void>((resolve, reject) => {
		if (!server.listening) {
			resolve();
			return;
		}
		server.close((error) => (error ? reject(error) : resolve()));
	});
const open = async (root: string) => {
	const db = new SqliteDatabase(join(root, "forge.sqlite"));
	cleanups.push(() => db.close());
	await db.initialize();
	const store = new ProjectStore(db);
	await store.initialize();
	const repositories = new RepositoryClient(root, [], files, new GitTransport());
	const access = new AccessService({ owner: "owner", origin: "https://forge.example.com" });
	const projects = new ProjectService(store, repositories, access, randomUUID, () => new Date());
	await projects.recover();
	const server = createServer(new HttpApplication(new ProjectRouter(projects), access).create().callback());
	cleanups.push(() => closeServer(server));
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing listener");
	return {
		db,
		store,
		repositories,
		request: (path: string, options?: RequestInit) =>
			fetch(`http://127.0.0.1:${address.port}${path}`, { ...options, headers: options?.headers ?? headers }),
		close: async () => {
			await closeServer(server);
			await db.close();
		},
	};
};

test("HTTP projects survive restart and recover intents across both sides of Git publication", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-integration-"));
	cleanups.push(() => files.rm(root, { recursive: true, force: true }));
	const first = await open(root);
	const response = await first.request("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name: "Created" }),
	});
	expect(response.status).toBe(201);
	const created = await response.json();
	const pending = {
		id: randomUUID(),
		name: "Before Git",
		status: "creating" as const,
		createdAt: new Date().toISOString(),
	};
	const published = { ...pending, id: randomUUID(), name: "After Git" };
	await first.store.insert(pending);
	await first.store.insert(published);
	await first.repositories.prepare(published.id);
	await first.close();
	const second = await open(root);
	const projects = await (await second.request("/api/projects")).json();
	expect(projects).toEqual(
		expect.arrayContaining([created, { ...pending, status: "ready" }, { ...published, status: "ready" }]),
	);
	expect(projects).toHaveLength(3);
	await second.repositories.verify(pending.id);
	await second.repositories.verify(published.id);
	expect(
		(
			await second.request("/api/projects", {
				method: "POST",
				headers: { ...headers, origin: "https://evil.example" },
				body: '{"name":"Denied"}',
			})
		).status,
	).toBe(403);
	expect(await second.store.list()).toHaveLength(3);
});

test("recovery fails closed on unrelated ready paths and never deletes their content", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-preservation-"));
	cleanups.push(() => files.rm(root, { recursive: true, force: true }));
	const first = await open(root);
	const record = {
		id: randomUUID(),
		name: "Unrelated",
		status: "ready" as const,
		createdAt: new Date().toISOString(),
	};
	await first.store.insert(record);
	const unrelated = join(root, "repositories", `${record.id}.git`);
	await files.mkdir(unrelated, { recursive: true });
	await files.writeFile(join(unrelated, "valuable"), "preserved");
	await first.close();
	const second = await open(root);
	expect(await (await second.request(`/api/projects/${record.id}`)).json()).toEqual({ ...record, status: "failed" });
	expect(await files.readFile(join(unrelated, "valuable"))).toBe("preserved");
	expect((await second.request(`/api/projects/${record.id}/retry`, { method: "POST" })).status).toBe(503);
	expect(await files.readFile(join(unrelated, "valuable"))).toBe("preserved");
});
