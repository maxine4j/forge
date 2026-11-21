import type { ModelProvider } from "@forge/contracts/model-providers";
import { inferenceProviderSchema } from "@forge/contracts/settings";

import type { IDatabase } from "../database/sqlite-database.ts";
import type { SqlStatement } from "../database/types.ts";

/** Runs once before recovery. Never changes an existing agent's inference snapshot. */
export async function migrateModelProviders(database: IDatabase, id: () => string, hasAccount: boolean): Promise<void> {
	await database.run("CREATE TABLE IF NOT EXISTS forge_migrations (version TEXT PRIMARY KEY)");
	if ((await database.all("SELECT version FROM forge_migrations WHERE version='named-model-providers-v1'")).length)
		return;
	const rows = await database.all("SELECT payload FROM forge_settings WHERE id=1");
	const legacy = rows.length ? JSON.parse((rows[0] as { payload: string }).payload) : {};
	const providers: (ModelProvider & {
		model?: string;
		defaultAgentModel?: string;
		defaultAgentReasoningEffort?: string;
	})[] = [];
	if (
		(rows.length && (legacy.inferenceProvider ?? "openai") === "openai")
		|| legacy.defaultAgentModel
		|| legacy.defaultAgentReasoningEffort
		|| hasAccount
		|| (await database.all("SELECT provider FROM account_login_attempts WHERE provider='codex'")).length
	) {
		providers.push({
			id: id(),
			name: "OpenAI",
			kind: "openai",
			retired: false,
			defaultAgentModel: legacy.defaultAgentModel,
			defaultAgentReasoningEffort: legacy.defaultAgentReasoningEffort,
		});
	}
	const ollama = inferenceProviderSchema.safeParse({
		kind: "ollama",
		endpoint: legacy.ollamaEndpoint,
		model: legacy.ollamaModel,
	});
	if (ollama.success && ollama.data.kind === "ollama")
		providers.push({
			id: id(),
			name: "Ollama",
			kind: "ollama",
			retired: false,
			endpoint: ollama.data.endpoint,
			model: ollama.data.model,
		});
	const selected = providers.find((value) => value.kind === (legacy.inferenceProvider ?? "openai"));
	const statements: SqlStatement[] = providers.map((value) => ({
		sql: "INSERT INTO model_providers(id,name,nameKey,kind,retired,record) VALUES(?,?,?,?,0,?)",
		parameters: [value.id, value.name, value.name.toLowerCase(), value.kind, JSON.stringify(value)],
	}));
	if (selected)
		statements.push({
			sql: `UPDATE tickets SET executionSettings=json_set(COALESCE(executionSettings,'{}'),'$.providerId',?) WHERE status IN ('backlog','todo') AND NOT EXISTS (SELECT 1 FROM ticket_workflows w WHERE w.ticketId=tickets.id AND (json_extract(w.record,'$.plannerId') IS NOT NULL OR json_extract(w.record,'$.implementerId') IS NOT NULL))`,
			parameters: [selected.id],
		});
	// Seed only known agents; absent provider on a legacy agent means OpenAI.
	statements.push({
		sql: `WITH originals AS (
   SELECT w.ticketId, COALESCE(json_extract(a.record,'$.provider'),'{"kind":"openai"}') AS configuration
   FROM ticket_workflows w JOIN agent_threads a
    ON a.id=COALESCE(json_extract(w.record,'$.implementerId'),json_extract(w.record,'$.plannerId'))
   WHERE json_extract(w.record,'$.providerSnapshot') IS NULL
  )
  UPDATE ticket_workflows SET record=json_set(record,'$.providerSnapshot',
   json_object('configuration',json(originals.configuration),'providerName',
    CASE json_extract(originals.configuration,'$.kind') WHEN 'ollama' THEN 'Ollama (legacy)' ELSE 'OpenAI (legacy)' END))
  FROM originals WHERE ticket_workflows.ticketId=originals.ticketId`,
	});
	// Identity is attached only when the original configuration matches a migrated provider.
	statements.push({
		sql: `WITH matches AS (
   SELECT w.ticketId,p.id,p.name FROM ticket_workflows w JOIN model_providers p
    ON p.kind=json_extract(w.record,'$.providerSnapshot.configuration.kind')
    AND (p.kind='openai' OR (
     json_extract(p.record,'$.endpoint')=json_extract(w.record,'$.providerSnapshot.configuration.endpoint')
     AND json_extract(p.record,'$.model')=json_extract(w.record,'$.providerSnapshot.configuration.model')))
   WHERE json_extract(w.record,'$.providerSnapshot.providerId') IS NULL
  )
  UPDATE ticket_workflows SET record=json_set(record,
   '$.providerSnapshot.providerId',matches.id,'$.providerSnapshot.providerName',matches.name)
  FROM matches WHERE ticket_workflows.ticketId=matches.ticketId`,
	});
	statements.push({ sql: "INSERT INTO forge_migrations(version) VALUES('named-model-providers-v1')" });
	await database.transaction(statements);
}
