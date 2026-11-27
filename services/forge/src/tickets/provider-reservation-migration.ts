import { modelProviderSchema } from "@forge/contracts/model-providers";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import { providerSnapshotSchema } from "../model-providers/types.ts";
import { normalizeTicketWorkflow } from "./types.ts";

const rowSchema = z.object({
	ticketId: z.string(),
	record: z.string(),
	planner: z.string().nullable(),
	implementer: z.string().nullable(),
});
const threadSchema = providerSnapshotSchema.omit({ configuration: true }).extend({
	provider: providerSnapshotSchema.shape.configuration.optional(),
});

/** Converts the catalog and reconstructs occupancy before any workflow can run. */
export async function migrateProviderReservations(database: IDatabase): Promise<void> {
	const version = "ticket-provider-reservations-v1";
	if ((await database.all("SELECT version FROM forge_migrations WHERE version=?", [version])).length) return;
	const providers = [];
	const updates: { ticketId: string; record: string }[] = [];
	for (let offset = 0; ; offset += 500) {
		const rows = await database.all("SELECT record FROM model_providers ORDER BY rowid LIMIT 500 OFFSET ?", [
			offset,
		]);
		for (const row of z.array(rowSchema.pick({ record: true })).parse(rows))
			providers.push(modelProviderSchema.parse(JSON.parse(row.record)));
		if (rows.length < 500) break;
	}
	for (let offset = 0; ; offset += 500) {
		const rows = await database.all(
			`SELECT w.ticketId,w.record,p.record AS planner,i.record AS implementer
			 FROM ticket_workflows w JOIN tickets t ON t.id=w.ticketId
			 LEFT JOIN agent_threads p ON p.id=COALESCE(w.record->>'$.plannerId',w.record->>'$.abandonment.plannerId')
			 LEFT JOIN agent_threads i ON i.id=COALESCE(w.record->>'$.implementerId',w.record->>'$.abandonment.implementerId')
			 WHERE t.archivedAt IS NULL AND (t.status='in-progress' OR w.record->>'$.state'='resetting')
			 ORDER BY w.rowid LIMIT 500 OFFSET ?`,
			[offset],
		);
		for (const row of z.array(rowSchema).parse(rows)) {
			const raw: unknown = JSON.parse(row.record);
			const job = normalizeTicketWorkflow(raw);
			if (job.reservation || job.resetStage === "cleanup") continue;
			const resetting = job.state === "resetting";
			const planning = resetting ? !row.implementer : job.phase === "planning";
			const threadJson = planning ? row.planner : row.implementer;
			const key = planning ? "planningProviderSnapshot" : "implementationProviderSnapshot";
			const previous =
				!planning && !threadJson && job.approvedRevision
					? z.object({ implementationProviderSnapshot: providerSnapshotSchema.optional() }).parse(raw)
							.implementationProviderSnapshot
					: job[key];
			if (!threadJson && !previous) continue;
			const thread = threadJson ? threadSchema.parse(JSON.parse(threadJson)) : undefined;
			const configuration = previous?.configuration ?? thread?.provider ?? { kind: "openai" as const };
			const matches = providers.filter(
				(provider) =>
					provider.kind === configuration.kind
					&& (configuration.kind === "openai" || provider.endpoint === configuration.endpoint),
			);
			const active = matches.filter((provider) => !provider.retired);
			const match = matches.length === 1 ? matches.at(0) : active.length === 1 ? active.at(0) : undefined;
			const providerId = previous?.providerId ?? thread?.providerId ?? match?.id;
			job[key] = {
				...previous,
				providerId,
				providerName: previous?.providerName ?? thread?.providerName ?? match?.name,
				configuration,
				model:
					previous?.model
					?? thread?.model
					?? (configuration.kind === "ollama" ? configuration.model : undefined),
				reasoningEffort: previous?.reasoningEffort ?? thread?.reasoningEffort,
			};
			job.reservation =
				providerId
				?? (configuration.kind === "openai" ? "legacy-openai" : `legacy-ollama:${configuration.endpoint}`);
			updates.push({ ticketId: row.ticketId, record: JSON.stringify(job) });
		}
		if (rows.length < 500) break;
	}
	await database.transaction([
		{
			sql: `UPDATE task_agents SET record=json_set(
				json_remove(record,'$.providerId','$.model','$.reasoningEffort'),
				'$.models',json_array(json_patch('{}',json_object('providerId',record->>'$.providerId',
					'model',record->>'$.model','reasoningEffort',record->>'$.reasoningEffort'))))
				WHERE json_type(record,'$.models') IS NULL`,
		},
		{
			sql: "UPDATE model_providers SET record=json_set(record,'$.maxConcurrentAgents',1) WHERE json_type(record,'$.maxConcurrentAgents') IS NULL",
		},
		{
			sql: `UPDATE ticket_workflows SET record=updates.value->>'record'
			       FROM json_each(?) AS updates WHERE ticket_workflows.ticketId=updates.value->>'ticketId'`,
			parameters: [JSON.stringify(updates)],
		},
		{ sql: "INSERT INTO forge_migrations(version) VALUES(?)", parameters: [version] },
	]);
}
