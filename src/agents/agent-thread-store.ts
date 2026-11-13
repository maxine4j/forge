import { agentContextWindowSchema, agentThreadSchema, agentRequestSchema } from "@forge/contracts/agents";
import { inferenceProviderSchema } from "@forge/contracts/settings";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import { AgentError } from "./errors.ts";
import type { AgentThreadRecord } from "./types.ts";
export interface IAgentThreadStore {
	/** Stores identifiers and normalized execution/approval state, never conversation history. Throws AgentError. */
	insert(record: AgentThreadRecord): Promise<void>;
	update(record: AgentThreadRecord): Promise<void>;
	get(id: string): Promise<AgentThreadRecord | undefined>;
	list(projectId: string): Promise<AgentThreadRecord[]>;
	/** Startup invalidates live execution/approval handles without replaying work. */
	recover(): Promise<void>;
}
export class AgentThreadStore implements IAgentThreadStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.guard(() =>
			this.database
				.run(
					"CREATE TABLE IF NOT EXISTS agent_threads (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), workspaceId TEXT NOT NULL REFERENCES workspaces(id), record TEXT NOT NULL)",
				)
				.then(() => {}),
		);
	}
	async insert(record: AgentThreadRecord): Promise<void> {
		await this.guard(async () => {
			const value = recordSchema.parse(record);
			await this.database.run("INSERT INTO agent_threads(id,projectId,workspaceId,record) VALUES(?,?,?,?)", [
				value.id,
				value.projectId,
				value.workspaceId,
				JSON.stringify(value),
			]);
		});
	}
	async update(record: AgentThreadRecord): Promise<void> {
		await this.guard(async () => {
			const value = recordSchema.parse(record);
			if (
				(await this.database.run(
					"UPDATE agent_threads SET record=? WHERE id=? AND projectId=? AND workspaceId=?",
					[JSON.stringify(value), value.id, value.projectId, value.workspaceId],
				)) !== 1
			)
				throw new AgentError("agent-not-found");
		});
	}
	async get(id: string): Promise<AgentThreadRecord | undefined> {
		return this.guard(async () => {
			const rows = await this.database.all("SELECT record FROM agent_threads WHERE id=?", [id]);
			return rows.length ? this.parse(rows[0]) : undefined;
		});
	}
	async list(projectId: string): Promise<AgentThreadRecord[]> {
		return this.guard(async () =>
			(
				await this.database.all("SELECT record FROM agent_threads WHERE projectId=? ORDER BY rowid DESC", [
					projectId,
				])
			).map((row) => this.parse(row)),
		);
	}
	async recover(): Promise<void> {
		await this.guard(async () => {
			await this.database.run(
				"UPDATE agent_threads SET record=json_set(record,'$.status','uncertain','$.requests',json('[]')) WHERE json_extract(record,'$.status') IN ('creating','running','waiting','uncertain')",
			);
		});
	}
	private parse(row: unknown): AgentThreadRecord {
		return recordSchema.parse(JSON.parse(z.object({ record: z.string() }).parse(row).record));
	}
	private async guard<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			if (cause instanceof AgentError) throw cause;
			throw new AgentError("agent-unavailable", { cause });
		}
	}
}
const recordSchema = agentThreadSchema.extend({
	managed: z.boolean().optional(),
	abandoned: z.boolean().optional(),
	codexId: z.string().min(1).max(256).optional(),
	requests: z.array(agentRequestSchema).max(32),
	contextWindow: agentContextWindowSchema.optional(),
	provider: inferenceProviderSchema.optional(),
});
