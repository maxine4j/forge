import { taskAgentSchema, type TaskAgent } from "@forge/contracts/task-agents";

import type { IDatabase } from "../database/sqlite-database.ts";

export interface ITaskAgentStore {
	list(): Promise<TaskAgent[]>;
	get(id: string): Promise<TaskAgent | undefined>;
	save(agent: TaskAgent): Promise<void>;
	retire(id: string): Promise<boolean>;
}

export function taskAgentWrite(agent: TaskAgent) {
	const value = taskAgentSchema.parse(agent);
	return {
		sql: "INSERT INTO task_agents(id,nameKey,retired,record) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET nameKey=excluded.nameKey,retired=excluded.retired,record=excluded.record WHERE task_agents.retired=0",
		parameters: [value.id, value.name.toLowerCase(), Number(value.retired), JSON.stringify(value)],
	};
}

export class TaskAgentStore implements ITaskAgentStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.database.transaction([
			{
				sql: "CREATE TABLE IF NOT EXISTS task_agents (id TEXT PRIMARY KEY, nameKey TEXT NOT NULL, retired INTEGER NOT NULL, record TEXT NOT NULL)",
			},
			{ sql: "CREATE UNIQUE INDEX IF NOT EXISTS task_agent_names ON task_agents(nameKey) WHERE retired=0" },
		]);
	}
	async list(): Promise<TaskAgent[]> {
		const records: TaskAgent[] = [];
		for (let offset = 0; ; offset += 500) {
			const rows = await this.database.all("SELECT record FROM task_agents ORDER BY rowid LIMIT 500 OFFSET ?", [
				offset,
			]);
			records.push(...rows.map(decode));
			if (rows.length < 500) return records;
		}
	}
	async get(id: string): Promise<TaskAgent | undefined> {
		const [row] = await this.database.all("SELECT record FROM task_agents WHERE id=?", [id]);
		return row ? decode(row) : undefined;
	}
	async save(agent: TaskAgent): Promise<void> {
		const { sql, parameters } = taskAgentWrite(agent);
		if ((await this.database.run(sql, parameters)) !== 1) throw new Error("Agent was retired");
	}
	async retire(id: string): Promise<boolean> {
		return (
			(await this.database.run(
				"UPDATE task_agents SET retired=1,record=json_set(record,'$.retired',json('true')) WHERE id=? AND retired=0",
				[id],
			)) === 1
		);
	}
}

function decode(row: unknown): TaskAgent {
	return taskAgentSchema.parse(JSON.parse((row as { record: string }).record));
}
