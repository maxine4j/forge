import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import type { AgentOptions } from "@forge/contracts/agents";
import type { InferenceProvider } from "@forge/contracts/settings";
import { defaultForgeSettings } from "@forge/contracts/settings";
import { expect, test, vi } from "vitest";

import { AccessService } from "../../src/auth/access-service.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { migrateModelProviders } from "../../src/model-providers/model-provider-migration.ts";
import { ModelProviderService } from "../../src/model-providers/model-provider-service.ts";
import { ModelProviderStore } from "../../src/model-providers/model-provider-store.ts";
import { migrateTaskAgents } from "../../src/task-agents/task-agent-migration.ts";
import { TaskAgentService } from "../../src/task-agents/task-agent-service.ts";
import { TaskAgentStore } from "../../src/task-agents/task-agent-store.ts";

const actor = { username: "owner" };
const access = new AccessService({ owner: "owner", origin: "https://forge.test" });
const ollama = { name: "Local", kind: "ollama", endpoint: "http://ollama/v1" };

async function fixture() {
	const root = await files.mkdtemp(join(tmpdir(), "forge-providers-"));
	const database = new SqliteDatabase(join(root, "test.sqlite"));
	await database.initialize();
	const store = new ModelProviderStore(database);
	await store.initialize();
	// Minimal legacy tables isolate the versioned migration from workflow bootstrapping.
	await database.transaction([
		{ sql: "CREATE TABLE forge_settings(id INTEGER PRIMARY KEY,payload TEXT)" },
		{ sql: "CREATE TABLE account_login_attempts(provider TEXT,pending INTEGER)" },
		{ sql: "CREATE TABLE tickets(id TEXT,status TEXT,executionSettings TEXT)" },
		{ sql: "CREATE TABLE ticket_workflows(ticketId TEXT,record TEXT)" },
		{ sql: "CREATE TABLE agent_threads(id TEXT,record TEXT)" },
	]);
	const catalog = vi.fn<(provider: InferenceProvider) => Promise<AgentOptions>>(async () => ({
		models: [],
		skills: [],
	}));
	const service = new ModelProviderService(store, access, randomUUID, catalog);
	const close = async () => {
		await database.close();
		await files.rm(root, { recursive: true, force: true });
	};
	return { database, store, service, catalog, close, root };
}

test("empty startup remains empty across restart and retirement never recreates providers", async () => {
	const f = await fixture();
	try {
		await migrateModelProviders(f.database, randomUUID, false);
		expect(await f.store.list()).toEqual([]);
		const provider = await f.service.create(actor, { name: "Account", kind: "openai" });
		await files.writeFile(join(f.root, "auth.json"), "preserved credentials");
		await f.service.remove(actor, provider.id);
		await migrateModelProviders(f.database, randomUUID, true);
		expect(await f.store.list()).toEqual([]);
		expect(await f.store.get(provider.id)).toMatchObject({ retired: true });
		expect((await files.readFile(join(f.root, "auth.json")))?.toString()).toBe("preserved credentials");
		const replacement = await f.service.create(actor, { name: "Account", kind: "openai" });
		expect(replacement.id).not.toBe(provider.id);
		await f.database.close();
		const reopened = new SqliteDatabase(join(f.root, "test.sqlite"));
		await reopened.initialize();
		try {
			await new ModelProviderStore(reopened).initialize();
			await migrateModelProviders(reopened, randomUUID, true);
			expect(await new ModelProviderStore(reopened).list()).toEqual([replacement]);
		} finally {
			await reopened.close();
		}
	} finally {
		await f.close();
	}
});

test("names, immutable kinds, explicit selections, catalogs and concurrent OpenAI uniqueness", async () => {
	const f = await fixture();
	try {
		await expect(f.service.create({ username: "other" }, ollama)).rejects.toThrow();
		for (const name of [" ", "a".repeat(121)])
			await expect(f.service.create(actor, { ...ollama, name })).rejects.toMatchObject({
				code: "invalid-provider",
			});
		for (const endpoint of ["/v1", "http://user@ollama/v1", "http://ollama/v1?key=secret", "http://ollama/api"])
			await expect(f.service.create(actor, { ...ollama, endpoint })).rejects.toMatchObject({
				code: "invalid-provider",
			});
		const local = await f.service.create(actor, { ...ollama, name: " Local " });
		expect(local.name).toBe("Local");
		expect(f.catalog).not.toHaveBeenCalled();
		await expect(f.service.create(actor, { ...ollama, name: "LOCAL" })).rejects.toMatchObject({
			code: "provider-conflict",
		});
		await expect(f.service.update(actor, local.id, { kind: "openai" })).rejects.toMatchObject({
			code: "invalid-provider",
		});
		await expect(f.service.options(actor, local.id)).rejects.toThrow("invalid-provider");
		expect(f.catalog).not.toHaveBeenCalled();
		const results = await Promise.allSettled([
			f.service.create(actor, { name: "One", kind: "openai" }),
			f.service.create(actor, { name: "Two", kind: "openai" }),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		await f.service.remove(actor, local.id);
		await expect(f.service.require(actor, local.id)).rejects.toMatchObject({ code: "provider-retired" });
		await expect(f.service.require(actor)).rejects.toMatchObject({ code: "provider-required" });
		await expect(f.service.require(actor, randomUUID())).rejects.toMatchObject({ code: "provider-not-found" });
		await expect(f.service.create(actor, ollama)).resolves.toMatchObject({ name: "Local" });
	} finally {
		await f.close();
	}
});

test("Ollama comparisons validate against pricing and can be cleared", async () => {
	const f = await fixture();
	try {
		await expect(f.service.create(actor, { ...ollama, comparisonModel: "missing" })).rejects.toThrow(
			"invalid-provider",
		);
		const local = await f.service.create(actor, { ...ollama, comparisonModel: " gpt-5.4 " });
		expect(local.comparisonModel).toBe("gpt-5.4");
		await expect(f.service.update(actor, local.id, { comparisonModel: null })).resolves.toMatchObject({
			comparisonModel: undefined,
		});
		await f.service.update(actor, local.id, { comparisonModel: "gpt-5.5" });
		await f.service.remove(actor, local.id);
		expect(await f.store.get(local.id)).toMatchObject({ retired: true, comparisonModel: "gpt-5.5" });
		expect(f.catalog).not.toHaveBeenCalled();
	} finally {
		await f.close();
	}
});

test("task agents validate catalogs, retain retired records and enforce active names", async () => {
	const f = await fixture();
	try {
		const store = new TaskAgentStore(f.database);
		await store.initialize();
		const agents = new TaskAgentService(store, f.service, access, randomUUID);
		const local = await f.service.create(actor, ollama);
		const input = { name: " Local agent ", providerId: local.id, model: " local:latest " };
		const agent = await agents.save(actor, input);
		expect(agent).toMatchObject({ name: "Local agent", model: "local:latest" });
		await expect(agents.save(actor, { ...input, name: "local AGENT" })).rejects.toMatchObject({ status: 409 });
		await expect(agents.save(actor, { ...input, reasoningEffort: "high" }, agent.id)).rejects.toMatchObject({
			status: 400,
		});
		expect(f.catalog).not.toHaveBeenCalled();
		const account = await f.service.create(actor, { name: "Account", kind: "openai" });
		f.catalog.mockResolvedValue({
			models: [
				{
					id: "model",
					name: "Model",
					isDefault: true,
					supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
				},
			],
			skills: [],
		});
		await expect(
			agents.save(actor, { name: "Planner", providerId: account.id, model: "missing" }),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			agents.save(actor, { name: "Planner", providerId: account.id, model: "model", reasoningEffort: "low" }),
		).rejects.toMatchObject({ status: 400 });
		await agents.save(actor, { name: "Planner", providerId: account.id, model: "model", reasoningEffort: "high" });
		await f.service.remove(actor, local.id);
		await agents.retire(actor, agent.id);
		expect(await store.get(agent.id)).toMatchObject({ retired: true });
		await expect(agents.save(actor, input, agent.id)).rejects.toMatchObject({ status: 409 });
	} finally {
		await f.close();
	}
});

test("migration routes unstarted tickets and seeds attempts from agents without changing their records", async () => {
	const f = await fixture();
	try {
		const legacy = {
			...defaultForgeSettings,
			inferenceProvider: "ollama",
			ollamaEndpoint: ollama.endpoint,
			ollamaModel: "local:latest",
			defaultAgentModel: "gpt-test",
			defaultAgentReasoningEffort: "high",
		};
		const agent = { provider: { kind: "ollama", endpoint: "http://old/v1", model: "original" } };
		await f.database.transaction([
			{ sql: "INSERT INTO forge_settings VALUES(1,?)", parameters: [JSON.stringify(legacy)] },
			{ sql: "INSERT INTO tickets VALUES('TASK-1','backlog','{\"skipPlanning\":true}')" },
			{ sql: "INSERT INTO tickets VALUES('TASK-2','in-progress',NULL)" },
			{ sql: "INSERT INTO agent_threads VALUES('agent',?)", parameters: [JSON.stringify(agent)] },
			{ sql: "INSERT INTO agent_threads VALUES('legacy','{}')" },
			{ sql: "INSERT INTO ticket_workflows VALUES('TASK-2','{\"plannerId\":\"agent\"}')" },
			{ sql: "INSERT INTO ticket_workflows VALUES('TASK-3','{\"implementerId\":\"legacy\"}')" },
			{
				sql: `INSERT INTO ticket_workflows VALUES('TASK-4','{"plannerId":"agent","implementerId":"legacy"}')`,
			},
		]);
		await migrateModelProviders(f.database, randomUUID, false);
		const providers = await f.store.list();
		expect(providers).toHaveLength(2);

		const tickets = (await f.database.all("SELECT executionSettings FROM tickets WHERE id='TASK-1'")) as {
			executionSettings: string;
		}[];
		expect(JSON.parse(tickets[0]!.executionSettings)).toEqual({
			skipPlanning: true,
			providerId: providers.find((p) => p.kind === "ollama")!.id,
		});
		const jobs = (await f.database.all("SELECT record FROM ticket_workflows ORDER BY ticketId")) as {
			record: string;
		}[];
		expect(JSON.parse(jobs[0]!.record).providerSnapshot.configuration).toEqual(agent.provider);
		expect(JSON.parse(jobs[1]!.record).providerSnapshot.configuration).toEqual({ kind: "openai" });
		expect(JSON.parse(jobs[2]!.record).providerSnapshot.configuration).toEqual({ kind: "openai" });
		expect(await f.database.all("SELECT record FROM agent_threads WHERE id='agent'")).toEqual([
			{ record: JSON.stringify(agent) },
		]);
		await migrateModelProviders(f.database, randomUUID, false);
		expect(await f.store.list()).toEqual(providers);
		expect(await f.database.all("SELECT record FROM ticket_workflows ORDER BY ticketId")).toEqual(jobs);
		const agents = new TaskAgentStore(f.database);
		await agents.initialize();
		await migrateTaskAgents(f.database, randomUUID);
		const catalog = await agents.list();
		const local = catalog.find((entry) => entry.model === "local:latest")!;
		expect(catalog).toContainEqual(expect.objectContaining({ model: "gpt-test", reasoningEffort: "high" }));
		const [migrated] = (await f.database.all("SELECT executionSettings FROM tickets WHERE id='TASK-1'")) as {
			executionSettings: string;
		}[];
		expect(JSON.parse(migrated!.executionSettings)).toEqual({
			skipPlanning: true,
			plannerAgentId: local.id,
			implementerAgentId: local.id,
		});
		const [pinned] = (await f.database.all("SELECT record FROM ticket_workflows WHERE ticketId='TASK-2'")) as {
			record: string;
		}[];
		expect(JSON.parse(pinned!.record).planningProviderSnapshot.configuration).toEqual(agent.provider);
		await migrateTaskAgents(f.database, () => {
			throw new Error("migration ran again");
		});
		expect(await agents.list()).toEqual(catalog);
	} finally {
		await f.close();
	}
});
