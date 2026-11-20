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

const actor = { username: "owner" };
const access = new AccessService({ owner: "owner", origin: "https://forge.test" });
const ollama = { name: "Local", kind: "ollama", endpoint: "http://ollama/v1", model: "local:latest" };

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
		await f.service.options(actor, local.id);
		expect(f.catalog).toHaveBeenCalledWith({ kind: "ollama", endpoint: ollama.endpoint, model: ollama.model });
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

test("OpenAI defaults can be validated, renamed without a catalog and cleared explicitly during an outage", async () => {
	const f = await fixture();
	try {
		f.catalog.mockResolvedValue({
			models: [
				{
					id: "model-a",
					name: "Model A",
					isDefault: true,
					supportedReasoningEfforts: [{ reasoningEffort: "high", description: "High" }],
				},
			],
			skills: [],
		});
		const provider = await f.service.create(actor, {
			kind: "openai",
			name: "Account",
			defaultAgentModel: "model-a",
			defaultAgentReasoningEffort: "high",
		});
		await expect(f.service.update(actor, provider.id, { defaultAgentModel: "missing" })).rejects.toThrow(
			"invalid-provider",
		);
		f.catalog.mockRejectedValue(new Error("offline"));
		await expect(f.service.update(actor, provider.id, { name: "Renamed" })).resolves.toMatchObject({
			name: "Renamed",
			defaultAgentModel: "model-a",
		});
		const cleared = await f.service.update(actor, provider.id, {
			defaultAgentModel: null,
			defaultAgentReasoningEffort: null,
		});
		expect(cleared.defaultAgentModel).toBeUndefined();
		expect(cleared.defaultAgentReasoningEffort).toBeUndefined();
		await f.service.remove(actor, provider.id);
		await expect(f.service.defaults(actor, provider.id)).resolves.toEqual({
			defaultModel: undefined,
			defaultReasoningEffort: undefined,
		});
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
			ollamaModel: ollama.model,
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
				sql: 'INSERT INTO ticket_workflows VALUES(\'TASK-4\',\'{"plannerId":"agent","implementerId":"legacy"}\')',
			},
		]);
		await migrateModelProviders(f.database, randomUUID, false);
		const providers = await f.store.list();
		expect(providers).toHaveLength(2);
		expect(providers.find((p) => p.kind === "openai")).toMatchObject({
			defaultAgentModel: "gpt-test",
			defaultAgentReasoningEffort: "high",
		});
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
	} finally {
		await f.close();
	}
});
