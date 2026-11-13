import { z } from "zod";

import { agentSettingsSchema } from "../agents/index.ts";

export const ticketExecutionSettingsSchema = agentSettingsSchema.extend({
	skipPlanning: z.boolean().optional(),
	acceptRecommendations: z.boolean().optional(),
});
export type TicketExecutionSettings = z.infer<typeof ticketExecutionSettingsSchema>;

export const ticketStatuses = ["backlog", "todo", "in-progress", "done"] as const;
export const ticketStatusSchema = z.enum(ticketStatuses);
export const ticketIdSchema = z.string().regex(/^TASK-[1-9]\d{0,14}$/u);
export const epicIdSchema = z.string().regex(/^EPIC-[1-9]\d{0,14}$/u);
export const repositoryIdsSchema = z
	.array(z.uuid())
	.max(1000)
	.refine((ids) => new Set(ids).size === ids.length, "Duplicate repositories");
export const createTicketSchema = z.strictObject({
	epicId: epicIdSchema.nullable().optional(),
	repositoryIds: repositoryIdsSchema.default([]),
	executionSettings: ticketExecutionSettingsSchema.optional(),
	title: z.string().trim().min(1).max(120),
	description: z.string().max(4000).default(""),
});
export const updateTicketSchema = createTicketSchema.omit({ executionSettings: true });
export const moveTicketSchema = z.strictObject({ status: ticketStatusSchema, beforeId: ticketIdSchema.optional() });
export const approveTicketPlanSchema = z.strictObject({ revision: z.number().int().positive() });
export const ticketMessageSchema = z.strictObject({
	text: z.string().trim().min(1).max(8000),
	expectedTurnId: z.string().min(1).max(256).optional(),
});
export const ticketSchema = z.strictObject({
	epicId: epicIdSchema.nullable().optional(),
	executionSettings: ticketExecutionSettingsSchema.optional(),
	id: ticketIdSchema,
	repositoryIds: repositoryIdsSchema,
	title: z.string().min(1).max(120),
	description: z.string().max(4000),
	status: ticketStatusSchema,
	createdAt: z.iso.datetime(),
	archivedAt: z.iso.datetime().optional(),
	needsAttention: z.literal(true).optional(),
	agentStatus: z.enum(["queued", "working"]).optional(),
	canReturnToBacklog: z.literal(true).optional(),
	resetting: z.literal(true).optional(),
});
export const ticketsSchema = z.array(ticketSchema).max(1000);
export const editEpicSchema = createTicketSchema.pick({ title: true, description: true });
export const epicSchema = editEpicSchema.extend({ id: epicIdSchema, createdAt: z.iso.datetime() });
export const epicSummarySchema = epicSchema.extend({
	counts: z.strictObject({
		backlog: z.number().int().nonnegative(),
		todo: z.number().int().nonnegative(),
		"in-progress": z.number().int().nonnegative(),
		done: z.number().int().nonnegative(),
	}),
	total: z.number().int().nonnegative(),
	done: z.number().int().nonnegative(),
	complete: z.boolean(),
});
export const epicsSchema = z.array(epicSummarySchema);
export const epicDetailSchema = epicSummarySchema.extend({ children: ticketsSchema });
export type Epic = z.infer<typeof epicSchema>;
export type EditEpic = z.input<typeof editEpicSchema>;
export type EpicSummary = z.infer<typeof epicSummarySchema>;
export type EpicDetail = z.infer<typeof epicDetailSchema>;
export const ticketWorkflowSchema = z.strictObject({
	ticketId: ticketIdSchema,
	executionRepositoryId: z.uuid().optional(),
	workspaceId: z.uuid().optional(),
	plannerId: z.uuid().optional(),
	implementerId: z.uuid().optional(),
	phase: z.enum(["planning", "implementation", "review", "rebase"]),
	state: z.enum([
		"idle",
		"queued",
		"dispatching",
		"running",
		"merge-queued",
		"setup-failed",
		"failed",
		"uncertain",
		"resetting",
	]),
	resetStage: z.enum(["stopping", "cleanup"]).optional(),
	resetError: z.string().optional(),
	plan: z.strictObject({ revision: z.number().int().positive(), text: z.string().min(1).max(32000) }).optional(),
	approvedRevision: z.number().int().positive().optional(),
	message: z.string().max(8000).optional(),
	baseSha: z
		.string()
		.regex(/^[a-f0-9]{40}$/u)
		.optional(),
	mergeAttempts: z.number().int().min(0).max(3),
	resultSha: z
		.string()
		.regex(/^[a-f0-9]{40}$/u)
		.optional(),
});
export type TicketWorkflow = z.infer<typeof ticketWorkflowSchema>;
/** Shared status-menu and drag eligibility. The server rechecks under workflow serialization. */
export function ticketMoveTargets(ticket: z.infer<typeof ticketSchema>): z.infer<typeof ticketStatusSchema>[] {
	if (ticket.archivedAt || ticket.resetting || ticket.status === "done") return [];
	if (ticket.status === "backlog") return ["todo"];
	if (!ticket.canReturnToBacklog) return [];
	return ticket.status === "in-progress" ? ["backlog", "todo"] : ["backlog"];
}
export type { Ticket, TicketStatus, CreateTicket, MoveTicket } from "./types.ts";
export * from "./board-settings.ts";
