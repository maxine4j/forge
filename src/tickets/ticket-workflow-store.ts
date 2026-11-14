import type { MoveTicket } from "@forge/contracts/tickets";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import type { SqlStatement } from "../database/types.ts";
import { TicketError } from "./errors.ts";
import type { INotificationStore } from "./notification-store.ts";
import { historyMilestoneStatements, workflowMilestones } from "./ticket-history-store.ts";
import { boardMoveStatements } from "./ticket-store.ts";
import { ticketWorkflowRecordSchema, type TicketWorkflowRecord } from "./types.ts";

export interface ITicketWorkflowStore {
	get(id: string): Promise<TicketWorkflowRecord | undefined>;
	/** Active jobs in board position order, globally paginated across the board. Idle/failed jobs are read by ID. */
	list(): Promise<TicketWorkflowRecord[]>;
	/** Done tickets with a recorded merge candidate and worktree, including archived tickets. */
	pendingCleanup(): Promise<TicketWorkflowRecord[]>;
	boardSummary(): Promise<TicketWorkflowRecord[]>;
	/** Persists job intent and any board move in one transaction. */
	save(record: TicketWorkflowRecord, move?: MoveTicket): Promise<void>;
}
export class TicketWorkflowStore implements ITicketWorkflowStore {
	private saveTail: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly database: IDatabase,
		private readonly now: () => Date = () => new Date(),
		private readonly notifications?: Pick<INotificationStore, "syncWorkflow">,
	) {}
	async initialize(): Promise<void> {
		await this.database.transaction([
			{
				sql: "CREATE TABLE IF NOT EXISTS ticket_completions (ticketId TEXT PRIMARY KEY REFERENCES tickets(id), completedAt TEXT NOT NULL)",
			},
			{
				sql: "CREATE TABLE IF NOT EXISTS ticket_workflows (ticketId TEXT PRIMARY KEY REFERENCES tickets(id), record TEXT NOT NULL)",
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
				"SELECT w.record FROM ticket_workflows w JOIN tickets t ON t.id=w.ticketId WHERE t.archivedAt IS NULL AND (json_extract(w.record,'$.state')='resetting' OR (t.status NOT IN ('backlog','done') AND json_extract(w.record,'$.state') IN ('queued','running','dispatching','uncertain','merge-queued'))) ORDER BY CASE json_extract(w.record,'$.state') WHEN 'running' THEN 0 WHEN 'merge-queued' THEN 1 ELSE 2 END,t.position,t.number LIMIT 500 OFFSET ?",
				[String(offset)],
			);
			jobs.push(...page);
			if (page.length < 500) return jobs;
		}
	}
	async boardSummary(): Promise<TicketWorkflowRecord[]> {
		return this.read(
			"SELECT w.record FROM ticket_workflows w JOIN tickets t ON t.id=w.ticketId WHERE t.archivedAt IS NULL AND t.status IN ('todo','in-progress') ORDER BY t.position,t.number",
			[],
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
		const operation = this.saveTail.then(() => this.persist(record, move));
		this.saveTail = operation.catch(() => {});
		return operation;
	}
	private async persist(record: TicketWorkflowRecord, move?: MoveTicket): Promise<void> {
		try {
			const value = ticketWorkflowRecordSchema.parse(record);
			const previous = await this.get(value.ticketId);
			const at = this.now().toISOString();
			const threadId = value.phase === "planning" ? value.plannerId : value.implementerId;
			const attempt = value.turnId && threadId ? `${threadId}:${value.turnId}` : undefined;
			const workspaceId =
				value.workspaceId ?? value.abandonment?.workspaceId ?? previous?.abandonment?.workspaceId;
			const associateVisit: SqlStatement = {
				sql: `INSERT INTO ticket_history_workspaces(workspaceId,visitId)
				 SELECT ?,id FROM ticket_history WHERE ? IS NOT NULL AND status IN ('todo','in-progress') AND id=(SELECT MAX(id) FROM ticket_history WHERE ticketId=? AND type='status')
				 ON CONFLICT(workspaceId) DO UPDATE SET visitId=excluded.visitId
				 WHERE (SELECT status FROM ticket_history WHERE id=ticket_history_workspaces.visitId)='todo'
				 AND (SELECT status FROM ticket_history WHERE id=excluded.visitId)='in-progress'`,
				parameters: [workspaceId ?? null, workspaceId ?? null, value.ticketId],
			};
			await this.database.transaction([
				// Capture the known execution visit before abandonment moves the ticket.
				associateVisit,
				...(move?.status === "done"
					? historyMilestoneStatements(
							value.ticketId,
							[{ type: "merged", outcome: "completed" }],
							at,
							attempt,
							workspaceId,
						)
					: []),
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
							...boardMoveStatements(value.ticketId, move, at),
						]
					: []),
				// Associate allocated workspaces with the admitted In progress visit.
				associateVisit,
				...historyMilestoneStatements(
					value.ticketId,
					workflowMilestones(previous, value),
					at,
					attempt,
					workspaceId,
				),
			]);
			await this.notifications?.syncWorkflow(value, at);
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
