import { modelProviderSchema, type ModelProvider } from "@forge/contracts/model-providers";

import type { IDatabase } from "../database/sqlite-database.ts";

export interface IModelProviderStore {
	list(includeRetired?: boolean): Promise<ModelProvider[]>;
	get(id: string): Promise<ModelProvider | undefined>;
	save(provider: ModelProvider): Promise<void>;
}
export class ModelProviderStore implements IModelProviderStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.database.transaction([
			{
				sql: "CREATE TABLE IF NOT EXISTS model_providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, nameKey TEXT NOT NULL, kind TEXT NOT NULL, retired INTEGER NOT NULL, record TEXT NOT NULL)",
			},
			{
				sql: "CREATE UNIQUE INDEX IF NOT EXISTS model_provider_names ON model_providers(nameKey) WHERE retired=0",
			},
			{
				sql: "CREATE UNIQUE INDEX IF NOT EXISTS model_provider_openai ON model_providers(kind) WHERE retired=0 AND kind='openai'",
			},
		]);
	}
	async list(includeRetired = false): Promise<ModelProvider[]> {
		const providers: ModelProvider[] = [];
		for (let offset = 0; ; offset += 500) {
			const rows = await this.database.all(
				`SELECT record FROM model_providers ${includeRetired ? "" : "WHERE retired=0"} ORDER BY rowid LIMIT 500 OFFSET ?`,
				[offset],
			);
			providers.push(...rows.map(decode));
			if (rows.length < 500) return providers;
		}
	}
	async get(id: string): Promise<ModelProvider | undefined> {
		const rows = await this.database.all("SELECT record FROM model_providers WHERE id=?", [id]);
		return rows.length ? decode(rows[0]) : undefined;
	}
	async save(provider: ModelProvider): Promise<void> {
		const value = modelProviderSchema.parse(provider);
		const changed = await this.database.run(
			"INSERT INTO model_providers(id,name,nameKey,kind,retired,record) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,nameKey=excluded.nameKey,retired=excluded.retired,record=excluded.record WHERE model_providers.kind=excluded.kind AND model_providers.retired=0",
			[value.id, value.name, value.name.toLowerCase(), value.kind, value.retired ? 1 : 0, JSON.stringify(value)],
		);
		if (changed !== 1) throw new Error("Provider was retired or changed kind");
	}
}
function decode(row: unknown): ModelProvider {
	return modelProviderSchema.parse(JSON.parse((row as { record: string }).record));
}
