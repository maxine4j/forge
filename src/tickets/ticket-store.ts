import { agentSettingsSchema, type AgentSettings } from "@forge/contracts/agents";
import {
	createTicketSchema,
	ticketSchema,
	type CreateTicket,
	type MoveTicket,
	type Ticket,
} from "@forge/contracts/tickets";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import { TicketError } from "./errors.ts";

const columns = "id, projectId, title, description, status, createdAt, executionSettings";
const settingsColumn = z
	.string()
	.nullable()
	.transform((value) => (value === null ? undefined : agentSettingsSchema.parse(JSON.parse(value))));
const readTicketSchema = ticketSchema.extend({ executionSettings: settingsColumn });
const ticketRowSchema = ticketSchema.extend({
	executionSettings: settingsColumn,
	archivedAt: ticketSchema.shape.archivedAt.nullable(),
});
const costTicketRowSchema = ticketRowSchema.pick({ id: true, title: true, archivedAt: true });
export interface ITicketStore {
	updateSettings(id: string, settings: AgentSettings): Promise<void>;
	/** Allocates an immutable globally increasing key; at most 1000 active tickets per project. */
	insert(projectId: string, input: CreateTicket, createdAt: string): Promise<Ticket>;
	get(id: string): Promise<Ticket | undefined>;
	/** Active tickets ordered by position within each status. */
	list(projectId: string): Promise<Ticket[]>;
	/** Preserves the first archive timestamp. Throws TicketError if the ticket is missing. */
	archive(id: string, archivedAt: string): Promise<void>;
	update(id: string, input: CreateTicket): Promise<void>;
	/** Atomically inserts before a validated same-project/status ticket, or appends. */
	move(id: string, input: MoveTicket): Promise<void>;
}
export class TicketStore implements ITicketStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.guard(async () => {
			await this.database.run(
				"CREATE TABLE IF NOT EXISTS tickets (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT GENERATED ALWAYS AS ('FORGE-' || number) STORED UNIQUE, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog','todo','in-progress','in-review','merging','done')), position INTEGER NOT NULL, createdAt TEXT NOT NULL)",
			);
			const archiveColumn = await this.database.all(
				"SELECT name FROM pragma_table_info('tickets') WHERE name='archivedAt'",
			);
			if (!archiveColumn.length) await this.database.run("ALTER TABLE tickets ADD COLUMN archivedAt TEXT");
			const settings = await this.database.all(
				"SELECT name FROM pragma_table_info('tickets') WHERE name='executionSettings'",
			);
			if (!settings.length) await this.database.run("ALTER TABLE tickets ADD COLUMN executionSettings TEXT");
			await this.database.run("CREATE INDEX IF NOT EXISTS tickets_board ON tickets(projectId, status, position)");
		});
	}
	async insert(projectId: string, input: CreateTicket, createdAt: string): Promise<Ticket> {
		return this.guard(async () => {
			const fields = createTicketSchema.parse(input);
			ticketSchema.pick({ projectId: true, createdAt: true }).parse({ projectId, createdAt });
			const rows = await this.database.all(
				`INSERT INTO tickets(projectId,title,description,createdAt,executionSettings,position) SELECT ?,?,?,?,?,COALESCE((SELECT MAX(position)+1 FROM tickets WHERE projectId=? AND status='backlog' AND archivedAt IS NULL),1) WHERE (SELECT COUNT(*) FROM tickets WHERE projectId=? AND archivedAt IS NULL) < 1000 RETURNING ${columns}`,
				[
					projectId,
					fields.title,
					fields.description,
					createdAt,
					fields.executionSettings ? JSON.stringify(fields.executionSettings) : null,
					projectId,
					projectId,
				],
			);
			return readTicketSchema.parse(rows.at(0));
		});
	}
	async get(id: string): Promise<Ticket | undefined> {
		return this.guard(async () => {
			const rows = await this.database.all(`SELECT ${columns}, archivedAt FROM tickets WHERE id=?`, [id]);
			if (!rows.length) return undefined;
			const { archivedAt, ...ticket } = ticketRowSchema.parse(rows.at(0));
			return archivedAt ? { ...ticket, archivedAt } : ticket;
		});
	}
	async list(projectId: string): Promise<Ticket[]> {
		return this.guard(async () =>
			(
				await this.database.all(
					`SELECT ${columns} FROM tickets WHERE projectId=? AND archivedAt IS NULL ORDER BY position,number`,
					[projectId],
				)
			).map((row) => readTicketSchema.parse(row)),
		);
	}
	async listForCost(projectId: string): Promise<{ id: string; title: string; archivedAt?: string }[]> {
		return this.guard(async () => {
			const tickets: { id: string; title: string; archivedAt?: string }[] = [];
			for (let offset = 0; ; offset += 500) {
				const rows = await this.database.all(
					"SELECT id, title, archivedAt FROM tickets WHERE projectId=? ORDER BY number LIMIT 500 OFFSET ?",
					[projectId, offset],
				);
				for (const row of rows) {
					const { id, title, archivedAt } = costTicketRowSchema.parse(row);
					tickets.push(archivedAt ? { id, title, archivedAt } : { id, title });
				}
				if (rows.length < 500) return tickets;
			}
		});
	}
	async archive(id: string, archivedAt: string): Promise<void> {
		await this.guard(async () => {
			const timestamp = ticketSchema.shape.archivedAt.unwrap().parse(archivedAt);
			const changes = await this.database.run("UPDATE tickets SET archivedAt=COALESCE(archivedAt,?) WHERE id=?", [
				timestamp,
				id,
			]);
			if (changes !== 1) throw new TicketError("ticket-not-found");
		});
	}
	async update(id: string, input: CreateTicket): Promise<void> {
		await this.guard(async () => {
			const fields = createTicketSchema.parse(input);
			if (
				(await this.database.run("UPDATE tickets SET title=?,description=? WHERE id=?", [
					fields.title,
					fields.description,
					id,
				])) !== 1
			)
				throw new TicketError("ticket-not-found");
		});
	}
	async updateSettings(id: string, settings: AgentSettings): Promise<void> {
		await this.guard(async () => {
			if (
				(await this.database.run("UPDATE tickets SET executionSettings=? WHERE id=?", [
					JSON.stringify(agentSettingsSchema.parse(settings)),
					id,
				])) !== 1
			)
				throw new TicketError("ticket-not-found");
		});
	}
	async move(id: string, input: MoveTicket): Promise<void> {
		await this.guard(() =>
			this.database.transaction([
				{
					sql: "UPDATE tickets SET position=position+1 WHERE projectId=(SELECT projectId FROM tickets WHERE id=?) AND status=? AND position >= (SELECT position FROM tickets WHERE id=?)",
					parameters: [id, input.status, input.beforeId ?? null],
				},
				{
					sql: "UPDATE tickets SET status=?,position=COALESCE((SELECT position-1 FROM tickets WHERE id=?),(SELECT COALESCE(MAX(position),0)+1 FROM tickets WHERE projectId=(SELECT projectId FROM tickets WHERE id=?) AND status=?)) WHERE id=?",
					parameters: [input.status, input.beforeId ?? null, id, input.status, id],
				},
			]),
		);
	}
	private async guard<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			if (cause instanceof TicketError) throw cause;
			throw new TicketError("ticket-unavailable", { cause });
		}
	}
}
