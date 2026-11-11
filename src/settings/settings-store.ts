import { defaultForgeSettings, forgeSettingsSchema, type ForgeSettings } from "@forge/contracts/settings";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";

export interface ISettingsStore {
	load(): Promise<ForgeSettings>;
	save(settings: ForgeSettings): Promise<void>;
}

export class SettingsStore implements ISettingsStore {
	constructor(private readonly database: IDatabase) {}

	async initialize(): Promise<void> {
		await this.database.run(
			"CREATE TABLE IF NOT EXISTS forge_settings (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)",
		);
	}

	async load(): Promise<ForgeSettings> {
		const rows = await this.database.all("SELECT payload FROM forge_settings WHERE id=1");
		if (!rows.length) return { ...defaultForgeSettings };
		const { payload } = z.object({ payload: z.string() }).parse(rows.at(0));
		const stored: unknown = JSON.parse(payload);
		return forgeSettingsSchema.parse(stored);
	}

	async save(settings: ForgeSettings): Promise<void> {
		await this.database.run(
			"INSERT INTO forge_settings(id,payload) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
			[JSON.stringify(settings)],
		);
	}
}
