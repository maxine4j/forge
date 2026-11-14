import { ticketExecutionSettingsSchema, type TicketExecutionSettings } from "@forge/contracts/tickets";
import {
	createTicketSchema,
	ticketSchema,
	type CreateTicket,
	type MoveTicket,
	type Ticket,
} from "@forge/contracts/tickets";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import type { SqlStatement } from "../database/types.ts";
import { epicTable } from "../epics/epic-store.ts";
import { TicketError } from "./errors.ts";
import { historyTables } from "./ticket-history-store.ts";

const columns = `id, epicId, title, description, status, createdAt, archivedAt, executionSettings,
 (SELECT json_group_array(repositoryId) FROM (SELECT repositoryId FROM ticket_repositories WHERE ticketId=tickets.id ORDER BY position)) AS repositoryIds`;
const rowSchema = ticketSchema.extend({
	repositoryIds: z.string().transform((value) => JSON.parse(value)),
	executionSettings: z
		.string()
		.nullable()
		.transform((value) => (value === null ? undefined : ticketExecutionSettingsSchema.parse(JSON.parse(value)))),
	archivedAt: ticketSchema.shape.archivedAt.nullable(),
});
const decode = (row: unknown): Ticket => {
	const { archivedAt, ...ticket } = rowSchema.parse(row);
	return ticketSchema.parse(archivedAt ? { ...ticket, archivedAt } : ticket);
};

/** Shared global column ordering for owner moves and workflow transitions. */
export const boardMoveStatements = (id: string, input: MoveTicket, at: string): SqlStatement[] => [
	{
		sql: `INSERT INTO ticket_history(ticketId,at,visitId,status,type,outcome)
		 SELECT t.id,?,h.id,t.status,'canceled','canceled' FROM tickets t JOIN ticket_history h ON h.ticketId=t.id
		 WHERE t.id=? AND ((t.status='in-progress' AND ? NOT IN ('in-progress','done')) OR (t.status='todo' AND ?='backlog'))
		 AND h.id=(SELECT MAX(id) FROM ticket_history WHERE ticketId=t.id AND type='status')`,
		parameters: [at, id, input.status, input.status],
	},
	{
		sql: "INSERT INTO ticket_history(ticketId,at,status,type,outcome) SELECT id,?,?,'status','completed' FROM tickets WHERE id=? AND status<>?",
		parameters: [at, input.status, id, input.status],
	},
	{
		sql: "UPDATE tickets SET position=position+1 WHERE status=? AND archivedAt IS NULL AND position >= (SELECT position FROM tickets WHERE id=?)",
		parameters: [input.status, input.beforeId ?? null],
	},
	{
		sql: "UPDATE tickets SET status=?,position=COALESCE((SELECT position-1 FROM tickets WHERE id=?),(SELECT COALESCE(MAX(position),0)+1 FROM tickets WHERE status=? AND archivedAt IS NULL)) WHERE id=?",
		parameters: [input.status, input.beforeId ?? null, input.status, id],
	},
];
const associations = (id: string, ids: string[]): SqlStatement[] => [
	{ sql: "DELETE FROM ticket_repositories WHERE ticketId=?", parameters: [id] },
	{
		sql: "INSERT INTO ticket_repositories(ticketId,repositoryId,position) SELECT ?,value,CAST(key AS INTEGER) FROM json_each(?)",
		parameters: [id, JSON.stringify(ids)],
	},
];
export interface ITicketStore {
	updateSettings(id: string, settings: TicketExecutionSettings): Promise<void>;
	/** Allocates an immutable global key; at most 1000 active tickets on the board. */
	insert(input: CreateTicket, createdAt: string): Promise<Ticket>;
	get(id: string): Promise<Ticket | undefined>;
	list(includeArchived?: boolean): Promise<Ticket[]>;
	archive(id: string, archivedAt: string): Promise<void>;
	update(id: string, input: CreateTicket): Promise<void>;
	move(id: string, input: MoveTicket): Promise<void>;
}
export class TicketStore implements ITicketStore {
	private insertTail: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly database: IDatabase,
		private readonly now: () => Date = () => new Date(),
	) {}
	async initialize(): Promise<void> {
		await this.guard(() =>
			this.database.transaction([
				epicTable,
				{
					sql: "CREATE TABLE IF NOT EXISTS tickets (number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT GENERATED ALWAYS AS ('TASK-' || number) STORED UNIQUE, epicId TEXT REFERENCES epics(id), title TEXT NOT NULL, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'backlog' CHECK(status IN ('backlog','todo','in-progress','done')), position INTEGER NOT NULL, createdAt TEXT NOT NULL, archivedAt TEXT, executionSettings TEXT)",
				},
				{
					sql: "CREATE TABLE IF NOT EXISTS ticket_repositories (ticketId TEXT NOT NULL REFERENCES tickets(id), repositoryId TEXT NOT NULL REFERENCES projects(id), position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(ticketId,repositoryId), UNIQUE(ticketId,position))",
				},
				{
					sql: "CREATE INDEX IF NOT EXISTS tickets_board ON tickets(status,position,number) WHERE archivedAt IS NULL",
				},
				{ sql: "CREATE INDEX IF NOT EXISTS tickets_epic ON tickets(epicId)" },
				{
					sql: "CREATE TRIGGER IF NOT EXISTS tickets_capacity BEFORE INSERT ON tickets WHEN (SELECT COUNT(*) FROM tickets WHERE archivedAt IS NULL)>=1000 BEGIN SELECT RAISE(ABORT,'Board capacity reached'); END",
				},
				...historyTables,
				{
					sql: "INSERT INTO ticket_history(ticketId,at,status,type,outcome,bootstrapped) SELECT id,?,status,'status','completed',1 FROM tickets WHERE NOT EXISTS (SELECT 1 FROM ticket_history WHERE ticketId=tickets.id)",
					parameters: [this.now().toISOString()],
				},
			]),
		);
	}
	async insert(input: CreateTicket, createdAt: string): Promise<Ticket> {
		const operation = this.insertTail.then(() =>
			this.guard(async () => {
				const fields = createTicketSchema.parse(input);
				ticketSchema.shape.createdAt.parse(createdAt);
				await this.database.transaction([
					{
						sql: "INSERT INTO tickets(title,description,createdAt,executionSettings,epicId,position) VALUES(?,?,?,?,?,COALESCE((SELECT MAX(position)+1 FROM tickets WHERE status='backlog' AND archivedAt IS NULL),1))",
						parameters: [
							fields.title,
							fields.description,
							createdAt,
							fields.executionSettings ? JSON.stringify(fields.executionSettings) : null,
							fields.epicId ?? null,
						],
					},
					{
						sql: "INSERT INTO ticket_repositories(ticketId,repositoryId,position) SELECT (SELECT id FROM tickets ORDER BY number DESC LIMIT 1),value,CAST(key AS INTEGER) FROM json_each(?)",
						parameters: [JSON.stringify(fields.repositoryIds)],
					},
				]);
				return decode(
					(await this.database.all(`SELECT ${columns} FROM tickets ORDER BY number DESC LIMIT 1`)).at(0),
				);
			}),
		);
		this.insertTail = operation.catch(() => {});
		return operation;
	}
	async get(id: string): Promise<Ticket | undefined> {
		return this.guard(async () => {
			const rows = await this.database.all(`SELECT ${columns} FROM tickets WHERE id=?`, [id]);
			return rows.length ? decode(rows[0]) : undefined;
		});
	}
	async list(includeArchived = false): Promise<Ticket[]> {
		return this.guard(async () =>
			(
				await this.database.all(
					`SELECT ${columns} FROM tickets ${includeArchived ? "" : "WHERE archivedAt IS NULL"} ORDER BY position,number`,
				)
			).map(decode),
		);
	}
	async listForCost(): Promise<{ id: string; title: string; archivedAt?: string }[]> {
		return this.guard(async () => {
			const tickets: { id: string; title: string; archivedAt?: string }[] = [];
			const schema = ticketSchema.pick({ id: true, title: true }).extend({ archivedAt: z.string().nullable() });
			for (let offset = 0; ; offset += 500) {
				const rows = await this.database.all(
					"SELECT id,title,archivedAt FROM tickets ORDER BY number LIMIT 500 OFFSET ?",
					[offset],
				);
				for (const row of rows) {
					const { archivedAt, ...ticket } = schema.parse(row);
					tickets.push(archivedAt ? { ...ticket, archivedAt } : ticket);
				}
				if (rows.length < 500) return tickets;
			}
		});
	}
	async archive(id: string, archivedAt: string): Promise<void> {
		await this.guard(async () => {
			ticketSchema.shape.archivedAt.unwrap().parse(archivedAt);
			if (
				(await this.database.run("UPDATE tickets SET archivedAt=COALESCE(archivedAt,?) WHERE id=?", [
					archivedAt,
					id,
				])) !== 1
			)
				throw new TicketError("ticket-not-found");
		});
	}
	async update(id: string, input: CreateTicket): Promise<void> {
		await this.guard(async () => {
			const fields = createTicketSchema.parse(input);
			if (!(await this.get(id))) throw new TicketError("ticket-not-found");
			await this.database.transaction([
				{
					sql: "UPDATE tickets SET title=?,description=? WHERE id=?",
					parameters: [fields.title, fields.description, id],
				},
				...associations(id, fields.repositoryIds),
				...(fields.epicId === undefined
					? []
					: [{ sql: "UPDATE tickets SET epicId=? WHERE id=?", parameters: [fields.epicId, id] }]),
			]);
		});
	}
	async updateSettings(id: string, settings: TicketExecutionSettings): Promise<void> {
		await this.guard(async () => {
			if (
				(await this.database.run("UPDATE tickets SET executionSettings=? WHERE id=?", [
					JSON.stringify(ticketExecutionSettingsSchema.parse(settings)),
					id,
				])) !== 1
			)
				throw new TicketError("ticket-not-found");
		});
	}
	async move(id: string, input: MoveTicket): Promise<void> {
		await this.guard(() => this.database.transaction(boardMoveStatements(id, input, this.now().toISOString())));
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
