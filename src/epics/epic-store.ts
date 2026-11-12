import { epicSchema, editEpicSchema, type Epic, type EditEpic } from "@forge/contracts/tickets";

import type { IDatabase } from "../database/sqlite-database.ts";
import { EpicError } from "./errors.ts";

export const epicTable = {
	sql: "CREATE TABLE IF NOT EXISTS epics (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT GENERATED ALWAYS AS ('EPIC-' || number) STORED UNIQUE, title TEXT NOT NULL, description TEXT NOT NULL, createdAt TEXT NOT NULL)",
};
export interface IEpicStore {
	list(): Promise<Epic[]>;
	get(id: string): Promise<Epic | undefined>;
	insert(input: EditEpic, createdAt: string): Promise<Epic>;
	update(id: string, input: EditEpic): Promise<void>;
}
export class EpicStore implements IEpicStore {
	private tail: Promise<unknown> = Promise.resolve();
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.guard(() => this.database.transaction([epicTable]));
	}
	async list(): Promise<Epic[]> {
		return this.guard(async () => {
			const values: Epic[] = [];
			for (let offset = 0; ; offset += 500) {
				const rows = await this.database.all(
					"SELECT id,title,description,createdAt FROM epics ORDER BY number LIMIT 500 OFFSET ?",
					[offset],
				);
				values.push(...rows.map((row) => epicSchema.parse(row)));
				if (rows.length < 500) return values;
			}
		});
	}
	async get(id: string): Promise<Epic | undefined> {
		return this.guard(async () => {
			const rows = await this.database.all("SELECT id,title,description,createdAt FROM epics WHERE id=?", [id]);
			return rows.length ? epicSchema.parse(rows[0]) : undefined;
		});
	}
	async insert(input: EditEpic, createdAt: string): Promise<Epic> {
		const next = this.tail.then(() =>
			this.guard(async () => {
				const fields = editEpicSchema.parse(input);
				epicSchema.shape.createdAt.parse(createdAt);
				// RETURNING keeps allocation and the returned identity in the same statement.
				const rows = await this.database.all(
					"INSERT INTO epics(title,description,createdAt) VALUES(?,?,?) RETURNING id,title,description,createdAt",
					[fields.title, fields.description, createdAt],
				);
				return epicSchema.parse(rows[0]);
			}),
		);
		this.tail = next.catch(() => {});
		return next;
	}
	async update(id: string, input: EditEpic): Promise<void> {
		await this.guard(async () => {
			const fields = editEpicSchema.parse(input);
			if (
				(await this.database.run("UPDATE epics SET title=?,description=? WHERE id=?", [
					fields.title,
					fields.description,
					id,
				])) !== 1
			)
				throw new EpicError("epic-not-found");
		});
	}
	private async guard<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			if (cause instanceof EpicError) throw cause;
			throw new EpicError("epic-unavailable", { cause });
		}
	}
}
