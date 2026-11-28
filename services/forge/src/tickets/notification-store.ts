import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import { normalizeTicketWorkflow, type TicketWorkflowRecord } from "./types.ts";

export function workflowNotificationKeys(job: TicketWorkflowRecord, status = "in-progress"): string[] {
	const attempt = `${job.plannerId ?? ""}:${job.implementerId ?? ""}:${job.turnId ?? ""}`;
	const keys: string[] = [];
	if (["setup-failed", "failed", "uncertain"].includes(job.state)) keys.push(`${job.state}:${attempt}`);
	if (
		status === "in-progress"
		&& (job.state === "idle" || job.state === "failed")
		&& job.phase === "planning"
		&& job.plan
		&& !job.approvedRevision
	)
		keys.push(`plan:${job.plan.revision}`);
	if (status === "in-progress" && job.state === "idle" && job.phase === "review") keys.push(`review:${attempt}`);
	if (job.cleanupFailed || job.resetError) keys.push(`cleanup:${attempt}`);
	return keys;
}

export interface NotificationMetadata {
	id: string;
	source: string;
	condition: string;
	at: string;
	archivedAt: string | null;
}
export interface INotificationStore {
	sync(source: string, conditions: string[], observedAt?: string): Promise<void>;
	syncWorkflow(job: TicketWorkflowRecord, observedAt?: string): Promise<void>;
	read(): Promise<NotificationMetadata[]>;
	archive(id: string): Promise<void>;
	workflows(): Promise<TicketWorkflowRecord[]>;
}

/** Only identity and first-observed time are durable; content remains authoritative elsewhere. */
export class NotificationStore implements INotificationStore {
	private tail: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly database: IDatabase,
		private readonly now: () => Date,
	) {}
	async initialize(): Promise<void> {
		await this.database.run(`CREATE TABLE IF NOT EXISTS ticket_notifications (
			id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, condition TEXT NOT NULL,
			at TEXT NOT NULL, UNIQUE(source,condition))`);
		const columns = z
			.array(z.object({ name: z.string() }))
			.parse(await this.database.all("PRAGMA table_info(ticket_notifications)"));
		if (!columns.some(({ name }) => name === "archivedAt"))
			await this.database.run("ALTER TABLE ticket_notifications ADD COLUMN archivedAt TEXT");
	}
	archive(id: string): Promise<void> {
		const operation = this.tail.then(async () => {
			await this.database.run("UPDATE ticket_notifications SET archivedAt=? WHERE id=? AND archivedAt IS NULL", [
				this.now().toISOString(),
				id,
			]);
		});
		this.tail = operation.catch(() => {});
		return operation;
	}
	sync(source: string, conditions: string[], observedAt?: string): Promise<void> {
		const operation = this.tail.then(async () => {
			const at = observedAt ?? this.now().toISOString();
			await this.database.transaction([
				{
					sql: `DELETE FROM ticket_notifications WHERE source=?${conditions.length ? ` AND condition NOT IN (${conditions.map(() => "?").join(",")})` : ""}`,
					parameters: [source, ...conditions],
				},
				...conditions.map((condition) => ({
					sql: "INSERT OR IGNORE INTO ticket_notifications(source,condition,at) VALUES(?,?,?)",
					parameters: [source, condition, at],
				})),
			]);
		});
		this.tail = operation.catch(() => {});
		return operation;
	}
	async read(): Promise<NotificationMetadata[]> {
		await this.tail;
		const result: NotificationMetadata[] = [];
		for (let offset = 0; ; offset += 500) {
			const rows = await this.database.all(
				"SELECT CAST(id AS TEXT) AS id,source,condition,at,archivedAt FROM ticket_notifications ORDER BY at,id LIMIT 500 OFFSET ?",
				[offset],
			);
			result.push(
				...rows.map((row) =>
					z
						.object({
							id: z.string(),
							source: z.string(),
							condition: z.string(),
							at: z.iso.datetime(),
							archivedAt: z.iso.datetime().nullable(),
						})
						.parse(row),
				),
			);
			if (rows.length < 500) return result;
		}
	}
	async syncWorkflow(job: TicketWorkflowRecord, observedAt?: string): Promise<void> {
		const rows = await this.database.all("SELECT status,archivedAt FROM tickets WHERE id=?", [job.ticketId]);
		const ticket = rows.length
			? z.object({ status: z.string(), archivedAt: z.string().nullable() }).parse(rows[0])
			: undefined;
		await this.sync(
			`workflow:${job.ticketId}`,
			ticket && !ticket.archivedAt ? workflowNotificationKeys(job, ticket.status) : [],
			observedAt,
		);
	}
	async workflows(): Promise<TicketWorkflowRecord[]> {
		const result: TicketWorkflowRecord[] = [];
		for (let offset = 0; ; offset += 500) {
			const rows = await this.database.all(
				"SELECT w.record FROM ticket_workflows w JOIN tickets t ON t.id=w.ticketId WHERE t.archivedAt IS NULL ORDER BY t.number LIMIT 500 OFFSET ?",
				[offset],
			);
			result.push(
				...rows.map((row) =>
					normalizeTicketWorkflow(JSON.parse(z.object({ record: z.string() }).parse(row).record)),
				),
			);
			if (rows.length < 500) return result;
		}
	}
}
