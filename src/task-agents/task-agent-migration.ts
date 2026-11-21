import type { TaskAgent } from "@forge/contracts/task-agents";
import { ticketPhaseSettings, type TicketExecutionSettings } from "@forge/contracts/tickets";

import type { IDatabase } from "../database/sqlite-database.ts";
import type { ModelProviderSnapshot } from "../model-providers/types.ts";
import { taskAgentRow } from "./task-agent-store.ts";

type LegacyProvider = {
	id: string;
	name: string;
	kind: "openai" | "ollama";
	model?: string;
	defaultAgentModel?: string;
	defaultAgentReasoningEffort?: string;
};
type LegacyThread = {
	model?: string;
	reasoningEffort?: string;
	providerId?: string;
	providerName?: string;
	provider?: ModelProviderSnapshot["configuration"];
};

export async function migrateTaskAgents(database: IDatabase, id: () => string): Promise<void> {
	const version = "task-agents-v1";
	if ((await database.all("SELECT version FROM forge_migrations WHERE version=?", [version])).length) return;
	const providers = new Map<string, LegacyProvider>();
	for (let offset = 0; ; offset += 500) {
		const rows = await database.all("SELECT record FROM model_providers ORDER BY rowid LIMIT 500 OFFSET ?", [
			offset,
		]);
		for (const row of rows) {
			const provider = JSON.parse((row as { record: string }).record) as LegacyProvider;
			providers.set(provider.id, provider);
		}
		if (rows.length < 500) break;
	}
	const ticketUpdates: { id: string; settings: string }[] = [];
	const workflowUpdates: { ticketId: string; record: string }[] = [];
	const agents = new Map<string, TaskAgent>();
	const names = new Set<string>();
	const assign = (providerId?: string, model?: string, effort?: string) => {
		const provider = providerId ? providers.get(providerId) : undefined;
		if (!provider) return undefined;
		model = (model ?? provider.model ?? provider.defaultAgentModel)?.trim() || undefined;
		effort = provider.kind === "openai" ? effort?.trim() || undefined : undefined;
		const key = JSON.stringify([provider.id, model, effort]);
		const existing = agents.get(key);
		if (existing) return existing.id;
		const base = (model ? `${provider.name} · ${model}` : provider.name).slice(0, 120).trim();
		let name = base;
		for (let suffix = 2; names.has(name.toLowerCase()); suffix++) {
			const ending = ` (${suffix})`;
			name = base.slice(0, 120 - ending.length).trimEnd() + ending;
		}
		const agent = {
			id: id(),
			name,
			models: [{ providerId: provider.id, model, reasoningEffort: effort }],
			retired: false,
			maxConcurrentTickets: 1,
		};
		agents.set(key, agent);
		names.add(name.toLowerCase());
		return agent.id;
	};
	for (const provider of providers.values()) {
		if (provider.model || provider.defaultAgentModel || provider.defaultAgentReasoningEffort)
			assign(provider.id, undefined, provider.defaultAgentReasoningEffort);
	}
	for (let offset = 0; ; offset += 500) {
		const rows = (await database.all(
			`
			SELECT t.id, t.executionSettings, w.record AS workflow, p.record AS planner, i.record AS implementer
			FROM tickets t LEFT JOIN ticket_workflows w ON w.ticketId=t.id
			LEFT JOIN agent_threads p ON p.id=json_extract(w.record,'$.plannerId')
			LEFT JOIN agent_threads i ON i.id=json_extract(w.record,'$.implementerId')
			ORDER BY t.rowid LIMIT 500 OFFSET ?`,
			[offset],
		)) as {
			id: string;
			executionSettings: string | null;
			workflow: string | null;
			planner: string | null;
			implementer: string | null;
		}[];
		for (const row of rows) {
			const previous = JSON.parse(row.executionSettings ?? "{}") as TicketExecutionSettings;
			const { permissions, skipPlanning, acceptRecommendations } = previous;
			const settings: TicketExecutionSettings = { permissions, skipPlanning, acceptRecommendations };
			const workflow = JSON.parse(row.workflow ?? "{}") as {
				providerSnapshot?: ModelProviderSnapshot;
				planningProviderSnapshot?: ModelProviderSnapshot;
				implementationProviderSnapshot?: ModelProviderSnapshot;
			};
			for (const phase of ["planning", "implementation"] as const) {
				const selection = ticketPhaseSettings(previous, phase);
				const snapshotKey =
					phase === "planning" ? "planningProviderSnapshot" : "implementationProviderSnapshot";
				const threadJson = phase === "planning" ? row.planner : row.implementer;
				const thread = threadJson ? (JSON.parse(threadJson) as LegacyThread) : undefined;
				const pin =
					workflow[snapshotKey]
					?? (thread
						? {
								providerId:
									thread.providerId
									?? (workflow.providerSnapshot?.configuration.kind
									=== (thread.provider?.kind ?? "openai")
										? workflow.providerSnapshot?.providerId
										: undefined),
								providerName: thread.providerName ?? workflow.providerSnapshot?.providerName,
								configuration: thread.provider ?? { kind: "openai" as const },
							}
						: (workflow.providerSnapshot
							?? (phase === "implementation" && !selection.providerId
								? workflow.planningProviderSnapshot
								: undefined)));
				const providerId = pin?.providerId ?? selection.providerId;
				const provider = providerId ? providers.get(providerId) : undefined;
				const model =
					pin?.configuration.kind === "ollama"
						? pin.configuration.model
						: (thread?.model ?? selection.model ?? provider?.defaultAgentModel);
				const effort =
					thread?.reasoningEffort
					?? selection.reasoningEffort
					?? (selection.model ? undefined : provider?.defaultAgentReasoningEffort);
				const agentId = assign(providerId, model, effort);
				if (phase === "planning") settings.plannerAgentId = agentId;
				else settings.implementerAgentId = agentId;
				if (pin) workflow[snapshotKey] = { ...pin, agentId, model, reasoningEffort: effort };
			}
			delete workflow.providerSnapshot;
			if (row.executionSettings || settings.plannerAgentId || settings.implementerAgentId)
				ticketUpdates.push({ id: row.id, settings: JSON.stringify(settings) });
			if (row.workflow) workflowUpdates.push({ ticketId: row.id, record: JSON.stringify(workflow) });
		}
		if (rows.length < 500) break;
	}
	// Keep the statement count fixed while committing all migrated records and the marker together.
	await database.transaction([
		{
			sql: `INSERT INTO task_agents(id,nameKey,retired,record)
				SELECT value->>'id', value->>'nameKey', value->>'retired', value->>'record' FROM json_each(?)`,
			parameters: [JSON.stringify([...agents.values()].map(taskAgentRow))],
		},
		{
			sql: `UPDATE tickets SET executionSettings = updates.value->>'settings'
				FROM json_each(?) AS updates WHERE tickets.id = updates.value->>'id'`,
			parameters: [JSON.stringify(ticketUpdates)],
		},
		{
			sql: `UPDATE ticket_workflows SET record = updates.value->>'record'
				FROM json_each(?) AS updates WHERE ticket_workflows.ticketId = updates.value->>'ticketId'`,
			parameters: [JSON.stringify(workflowUpdates)],
		},
		{
			sql: "UPDATE model_providers SET record=json_remove(record,'$.model','$.defaultAgentModel','$.defaultAgentReasoningEffort')",
		},
		{ sql: "INSERT INTO forge_migrations(version) VALUES(?)", parameters: [version] },
	]);
}
