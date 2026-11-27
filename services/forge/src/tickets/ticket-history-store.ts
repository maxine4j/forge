import type { AgentTurnFailure } from "@forge/contracts/agents";
import {
	ticketHistorySchema,
	ticketHistoryEventSchema,
	type TicketHistory,
	type TicketHistoryEvent,
} from "@forge/contracts/tickets";
import { z } from "zod";

import type { AgentThreadRecord } from "../agents/types.ts";
import type { IDatabase } from "../database/sqlite-database.ts";
import type { SqlStatement } from "../database/types.ts";
import type { TicketWorkflowRecord } from "./types.ts";

export interface ITicketAgentHistory {
	observe(record: AgentThreadRecord, failure?: AgentTurnFailure): Promise<void>;
}

/** Initialized with ticket storage, before workflows or agent recovery. */
export const historyTables: SqlStatement[] = [
	{
		sql: `CREATE TABLE IF NOT EXISTS ticket_history (
	 id INTEGER PRIMARY KEY AUTOINCREMENT, ticketId TEXT NOT NULL REFERENCES tickets(id),
	 at TEXT NOT NULL, visitId INTEGER REFERENCES ticket_history(id), status TEXT NOT NULL,
	 type TEXT NOT NULL, outcome TEXT NOT NULL, revision INTEGER, reason TEXT,
	 attempt TEXT, bootstrapped INTEGER NOT NULL DEFAULT 0)`,
	},
	{ sql: "CREATE INDEX IF NOT EXISTS ticket_history_ticket ON ticket_history(ticketId,id)" },
	{
		sql: "CREATE TABLE IF NOT EXISTS ticket_history_agent_states (threadId TEXT NOT NULL, turnId TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(threadId,turnId))",
	},
	{
		sql: "CREATE TABLE IF NOT EXISTS ticket_history_workspaces (workspaceId TEXT PRIMARY KEY, visitId INTEGER NOT NULL REFERENCES ticket_history(id))",
	},
	{
		sql: `CREATE TRIGGER IF NOT EXISTS ticket_history_create AFTER INSERT ON tickets BEGIN
	 INSERT INTO ticket_history(ticketId,at,status,type,outcome) VALUES(NEW.id,NEW.createdAt,NEW.status,'status','completed'); END`,
	},
];

type Milestone = Pick<TicketHistoryEvent, "type" | "outcome" | "revision" | "reason"> & {
	independentFailure?: boolean;
};
/** Only normalized state is recorded: never plan text, feedback, diagnostics, or credentials. */
export function workflowMilestones(old: TicketWorkflowRecord | undefined, next: TicketWorkflowRecord): Milestone[] {
	const events: Milestone[] = [];
	const add = (
		type: Milestone["type"],
		outcome: Milestone["outcome"] = "completed",
		reason?: string,
		independentFailure?: boolean,
	) => events.push({ type, outcome, ...(reason && { reason }), ...(independentFailure && { independentFailure }) });
	if (next.plan && next.plan.revision !== old?.plan?.revision) {
		events.push({
			type: next.plan.revision === 1 ? "plan-created" : "plan-adjusted",
			outcome: "completed",
			revision: next.plan.revision,
		});
		add("awaiting-approval", "action-required");
	}
	if (next.approvedRevision && next.approvedRevision !== old?.approvedRevision)
		events.push({ type: "plan-approved", outcome: "completed", revision: next.approvedRevision });
	if (["queued", "merge-queued"].includes(next.state) && old && ["failed", "setup-failed"].includes(old.state))
		add("retry", "queued");
	if (next.state === "queued" && (old?.state !== "queued" || old?.phase !== next.phase))
		add(next.phase === "planning" ? "planning" : next.phase === "rebase" ? "rebasing" : "implementing", "queued");
	if (next.state === "dispatching" && old?.state !== "dispatching")
		add(next.phase === "planning" ? "planning" : next.phase === "rebase" ? "rebasing" : "implementing", "working");
	if (next.resultSha && next.resultSha !== old?.resultSha) add("implemented");
	if (next.state === "merge-queued" && old?.state !== "merge-queued") add("merge-queued", "queued");
	if (["failed", "setup-failed"].includes(next.state) && next.state !== old?.state)
		add(
			"failure",
			"failed",
			next.state === "setup-failed"
				? "Execution setup failed. Retry from Chat."
				: old?.state === "merge-queued"
					? "Merge failed. Review Chat and retry."
					: "Execution failed. Review Chat and retry.",
			next.state === "setup-failed" || old?.state === "merge-queued",
		);
	if (next.state === "uncertain" && old?.state !== "uncertain")
		add("recovery", "action-required", "Reconcile execution in Chat.");
	if (next.state === "running" && old?.state === "uncertain") add("resumed", "working");
	if (next.resetStage === "cleanup" && old?.resetStage !== "cleanup") add("cleanup", "working");
	if (next.resetError && next.resetError !== old?.resetError)
		add("failure", "failed", "Cleanup failed. Retry from the existing controls.", true);
	if (next.cleanupFailed && !old?.cleanupFailed)
		add("failure", "failed", "Workspace cleanup failed. Cleanup will retry.", true);
	if (old?.cleanupFailed && !next.cleanupFailed && !next.workspaceCleaned) {
		add("retry", "queued");
		add("cleanup", "working");
	}
	if ((next.workspaceCleaned && !old?.workspaceCleaned) || (old?.state === "resetting" && next.state !== "resetting"))
		add("cleanup");
	return events;
}

export function historyMilestoneStatements(
	ticketId: string,
	events: Milestone[],
	at: string,
	attempt?: string,
	workspaceId?: string,
): SqlStatement[] {
	return events.map((event) => {
		const operation = event.independentFailure ? undefined : attempt;
		return {
			sql: `INSERT INTO ticket_history(ticketId,at,visitId,status,type,outcome,revision,reason,attempt)
		 SELECT ticketId,?,id,status,?,?,?,?,? FROM ticket_history WHERE id=COALESCE((SELECT visitId FROM ticket_history_workspaces WHERE workspaceId=?),(SELECT MAX(id) FROM ticket_history WHERE ticketId=? AND type='status'))${event.type === "merged" ? " AND EXISTS (SELECT 1 FROM tickets WHERE tickets.id=ticket_history.ticketId AND tickets.status<>'done')" : ""}
		 AND (?<>'failure' OR ? IS NULL OR NOT EXISTS (SELECT 1 FROM ticket_history WHERE ticketId=? AND type IN ('failure','canceled') AND attempt=?))`,
			parameters: [
				at,
				event.type,
				event.outcome,
				event.revision ?? null,
				event.reason ?? null,
				operation ?? null,
				workspaceId ?? null,
				ticketId,
				event.type,
				operation ?? null,
				ticketId,
				operation ?? null,
			],
		};
	});
}

export class TicketHistoryStore implements ITicketAgentHistory {
	constructor(
		private readonly database: IDatabase,
		private readonly now: () => Date = () => new Date(),
	) {}
	async read(ticketId: string, after: number): Promise<TicketHistory> {
		const [metadata] = await this.database.all(
			"SELECT at AS recordedFrom,bootstrapped FROM ticket_history WHERE ticketId=? ORDER BY id LIMIT 1",
			[ticketId],
		);
		const start = z.object({ recordedFrom: z.string(), bootstrapped: z.number() }).parse(metadata);
		const rows = await this.database.all(
			`SELECT id,ticketId,at,COALESCE(visitId,id) AS visitId,status,type,outcome,revision,reason FROM ticket_history WHERE ticketId=? AND id>? ORDER BY id LIMIT 101`,
			[ticketId, after],
		);
		const events = rows.slice(0, 100).map((row) => {
			const { revision, reason, ...event } = row as Record<string, unknown>;
			return ticketHistoryEventSchema.parse({
				...event,
				...(revision !== null && { revision }),
				...(reason !== null && { reason }),
			});
		});
		return ticketHistorySchema.parse({
			...start,
			bootstrapped: Boolean(start.bootstrapped),
			events,
			...(rows.length > 100 && { nextCursor: events.at(-1)?.id }),
		});
	}
	async observe(record: AgentThreadRecord, failure?: AgentTurnFailure): Promise<void> {
		if (!record.managed || record.abandoned || !record.turnId) return;
		const type =
			record.status === "waiting"
				? "action-required"
				: record.status === "running"
					? "resumed"
					: record.status === "failed"
						? "failure"
						: record.status === "interrupted"
							? "canceled"
							: undefined;
		if (!type) return;
		const outcome =
			record.status === "waiting"
				? "action-required"
				: record.status === "running"
					? "working"
					: record.status === "failed"
						? "failed"
						: "canceled";
		await this.database.transaction([
			{
				sql: `INSERT INTO ticket_history(ticketId,at,visitId,status,type,outcome,reason,attempt)
			 SELECT h.ticketId,?,h.id,h.status,?,?,?,? FROM ticket_workflows w JOIN ticket_history h ON h.ticketId=w.ticketId
			 WHERE h.id=(SELECT MAX(id) FROM ticket_history WHERE ticketId=w.ticketId AND type='status')
			 AND json_extract(w.record,'$.state') IN ('dispatching','running','uncertain')
			 AND CASE json_extract(w.record,'$.phase') WHEN 'planning' THEN json_extract(w.record,'$.plannerId') ELSE json_extract(w.record,'$.implementerId') END=?
			 AND (json_extract(w.record,'$.turnId')=? OR (json_extract(w.record,'$.state')='dispatching' AND COALESCE(json_extract(w.record,'$.previousTurnId'),'')<>?))
			 AND COALESCE((SELECT status FROM ticket_history_agent_states WHERE threadId=? AND turnId=?),'')<>?
			 AND (?<>'resumed' OR (SELECT status FROM ticket_history_agent_states WHERE threadId=? AND turnId=?)='waiting')
			 AND (?<>'failure' OR NOT EXISTS (SELECT 1 FROM ticket_history WHERE ticketId=w.ticketId AND type='failure' AND attempt=?))`,
				parameters: [
					this.now().toISOString(),
					type,
					outcome,
					record.status === "waiting"
						? "Action required in Chat"
						: record.status === "failed"
							? failure === "context-window"
								? "The agent reached its context window limit. Review Chat and retry."
								: failure === "provider-request"
									? "The inference provider request failed. Review Chat and retry."
									: "Agent turn failed. Review Chat and retry."
							: null,
					`${record.id}:${record.turnId}`,
					record.id,
					record.turnId,
					record.turnId,
					record.id,
					record.turnId,
					record.status,
					type,
					record.id,
					record.turnId,
					type,
					`${record.id}:${record.turnId}`,
				],
			},
			{
				sql: "INSERT INTO ticket_history_agent_states(threadId,turnId,status) VALUES(?,?,?) ON CONFLICT(threadId,turnId) DO UPDATE SET status=excluded.status",
				parameters: [record.id, record.turnId, record.status],
			},
		]);
	}
}
