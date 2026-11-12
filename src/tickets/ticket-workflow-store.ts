import type { MoveTicket } from "@forge/contracts/tickets";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import { TicketError } from "./errors.ts";
import { ticketWorkflowRecordSchema, type TicketWorkflowRecord } from "./types.ts";

export interface ITicketWorkflowStore {
	get(id: string): Promise<TicketWorkflowRecord | undefined>;
	/** Active jobs in board position order, globally paginated across projects. Idle/failed jobs are read by ID. */
	list(): Promise<TicketWorkflowRecord[]>;
	/** Done tickets with a recorded merge candidate and worktree, including archived tickets. */
	pendingCleanup(): Promise<TicketWorkflowRecord[]>;
	boardSummary(projectId: string): Promise<TicketWorkflowRecord[]>;
	/** Persists job intent and any board move in one transaction. */
	save(record: TicketWorkflowRecord, move?: MoveTicket): Promise<void>;
}
export class TicketWorkflowStore implements ITicketWorkflowStore {
	constructor(
		private readonly database: IDatabase,
		private readonly now: () => Date = () => new Date(),
	) {}
	async initialize(): Promise<void> {
		await this.database.transaction([
			{
				sql: "CREATE TABLE IF NOT EXISTS ticket_completions (ticketId TEXT PRIMARY KEY REFERENCES tickets(id), completedAt TEXT NOT NULL)",
			},
			{
				sql: "CREATE TABLE IF NOT EXISTS ticket_workflows (ticketId TEXT PRIMARY KEY REFERENCES tickets(id), record TEXT NOT NULL)",
			},
			{
				sql: "UPDATE ticket_workflows SET record=json_set(record,'$.phase','review') WHERE ticketId IN (SELECT id FROM tickets WHERE status='in-review')",
			},
			{
				sql: "UPDATE ticket_workflows SET record=json_set(record,'$.state','merge-queued') WHERE ticketId IN (SELECT id FROM tickets WHERE status='merging') AND json_extract(record,'$.state')='queued' AND json_extract(record,'$.message') IS NULL",
			},
			{
				sql: "UPDATE tickets SET status='in-progress' WHERE status IN ('in-review','merging') OR (status='todo' AND id IN (SELECT ticketId FROM ticket_workflows WHERE json_extract(record,'$.state')<>'queued'))",
			},
			{
				sql: "UPDATE ticket_workflows SET record=json_set(record,'$.state','failed') WHERE json_type(record,'$.run') IS NOT NULL AND json_extract(record,'$.state') IN ('dispatching','uncertain')",
			},
			{
				sql: "UPDATE ticket_workflows SET record=json_remove(record,'$.run') WHERE json_type(record,'$.run') IS NOT NULL",
			},
		]);
	}
	async get(id: string): Promise<TicketWorkflowRecord | undefined> {
		const records = await this.read("SELECT record FROM ticket_workflows WHERE ticketId=?", [id]);
		return records.at(0);
	}
	async list(): Promise<TicketWorkflowRecord[]> {
		const jobs: TicketWorkflowRecord[] = [];
		for (let offset = 0; ; offset += 500) {
			const page = await this.read(
				"SELECT w.record FROM ticket_workflows w JOIN tickets t ON t.id=w.ticketId WHERE t.archivedAt IS NULL AND t.status NOT IN ('backlog','done') AND json_extract(w.record,'$.state') IN ('queued','running','dispatching','uncertain','merge-queued') ORDER BY CASE json_extract(w.record,'$.state') WHEN 'running' THEN 0 WHEN 'merge-queued' THEN 1 ELSE 2 END,t.position,t.number LIMIT 500 OFFSET ?",
				[String(offset)],
			);
			jobs.push(...page);
			if (page.length < 500) return jobs;
		}
	}
	async boardSummary(projectId: string): Promise<TicketWorkflowRecord[]> {
		return this.read(
			"SELECT w.record FROM ticket_workflows w JOIN tickets t ON t.id=w.ticketId WHERE t.projectId=? AND t.archivedAt IS NULL AND t.status IN ('todo','in-progress') ORDER BY t.position,t.number",
			[projectId],
		);
	}
	async pendingCleanup(): Promise<TicketWorkflowRecord[]> {
		const jobs: TicketWorkflowRecord[] = [];
		for (let offset = 0; ; offset += 500) {
			const page = await this.read(
				`SELECT w.record FROM ticket_workflows w JOIN tickets t ON t.id=w.ticketId
				 WHERE t.status='done' AND json_type(w.record,'$.workspaceId')='text'
				   AND json_type(w.record,'$.resultSha')='text' AND json_type(w.record,'$.workspaceCleaned') IS NULL
				 ORDER BY t.number LIMIT 500 OFFSET ?`,
				[String(offset)],
			);
			jobs.push(...page);
			if (page.length < 500) return jobs;
		}
	}
	async save(record: TicketWorkflowRecord, move?: MoveTicket): Promise<void> {
		try {
			const value = ticketWorkflowRecordSchema.parse(record);
			await this.database.transaction([
				{
					sql: "INSERT INTO ticket_workflows(ticketId,record) VALUES(?,?) ON CONFLICT(ticketId) DO UPDATE SET record=excluded.record",
					parameters: [value.ticketId, JSON.stringify(value)],
				},
				...(move
					? [
							{
								sql: "INSERT OR IGNORE INTO ticket_completions(ticketId,completedAt) SELECT id,? FROM tickets WHERE id=? AND status<>'done' AND ?='done'",
								parameters: [this.now().toISOString(), value.ticketId, move.status],
							},
							{
								sql: "UPDATE tickets SET position=position+1 WHERE projectId=(SELECT projectId FROM tickets WHERE id=?) AND status=? AND archivedAt IS NULL AND position >= (SELECT position FROM tickets WHERE id=?)",
								parameters: [value.ticketId, move.status, move.beforeId ?? null],
							},
							{
								sql: "UPDATE tickets SET status=?,position=COALESCE((SELECT position-1 FROM tickets WHERE id=?),(SELECT COALESCE(MAX(position),0)+1 FROM tickets WHERE projectId=(SELECT projectId FROM tickets WHERE id=?) AND status=? AND archivedAt IS NULL)) WHERE id=?",
								parameters: [
									move.status,
									move.beforeId ?? null,
									value.ticketId,
									move.status,
									value.ticketId,
								],
							},
						]
					: []),
			]);
		} catch (cause) {
			throw new TicketError("ticket-unavailable", { cause });
		}
	}
	private async read(sql: string, parameters: string[]): Promise<TicketWorkflowRecord[]> {
		try {
			return (await this.database.all(sql, parameters)).map((row) =>
				ticketWorkflowRecordSchema.parse(JSON.parse(z.object({ record: z.string() }).parse(row).record)),
			);
		} catch (cause) {
			throw new TicketError("ticket-unavailable", { cause });
		}
	}
}
