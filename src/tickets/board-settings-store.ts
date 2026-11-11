import { boardSettingsSchema, defaultBoardSettings, type BoardSettings } from "@forge/contracts/tickets";

import type { IDatabase } from "../database/sqlite-database.ts";
import { TicketError } from "./errors.ts";

export interface IBoardSettingsStore {
	load(): Promise<BoardSettings>;
	save(settings: BoardSettings): Promise<void>;
}

export class BoardSettingsStore implements IBoardSettingsStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.database.run(
			"CREATE TABLE IF NOT EXISTS board_settings (id INTEGER PRIMARY KEY CHECK(id=1), dispatch TEXT NOT NULL, maxAgents INTEGER NOT NULL)",
		);
	}
	async load(): Promise<BoardSettings> {
		const rows = await this.database.all("SELECT dispatch,maxAgents FROM board_settings WHERE id=1");
		return rows.length ? boardSettingsSchema.parse(rows.at(0)) : { ...defaultBoardSettings };
	}
	async save(settings: BoardSettings): Promise<void> {
		try {
			await this.database.run(
				"INSERT INTO board_settings(id,dispatch,maxAgents) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET dispatch=excluded.dispatch,maxAgents=excluded.maxAgents",
				[settings.dispatch, settings.maxAgents],
			);
		} catch (cause) {
			throw new TicketError("ticket-unavailable", { cause });
		}
	}
}
