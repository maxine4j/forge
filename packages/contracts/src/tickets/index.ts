import { z } from "zod";

export const ticketStatuses = ["backlog", "todo", "in-progress", "done"] as const;
export const ticketStatusSchema = z.enum(ticketStatuses);
export const ticketIdSchema = z.string().regex(/^FORGE-[1-9]\d{0,14}$/u);
export const createTicketSchema = z.strictObject({
	title: z.string().trim().min(1).max(120),
	description: z.string().max(4000).default(""),
});
export const updateTicketSchema = createTicketSchema;
export const moveTicketSchema = z.strictObject({ status: ticketStatusSchema, beforeId: ticketIdSchema.optional() });
export const approveTicketPlanSchema = z.strictObject({ revision: z.number().int().positive() });
export const ticketMessageSchema = z.strictObject({
	text: z.string().trim().min(1).max(8000),
	expectedTurnId: z.string().min(1).max(256).optional(),
});
export const ticketSchema = z.strictObject({
	id: ticketIdSchema,
	projectId: z.uuid(),
	title: z.string().min(1).max(120),
	description: z.string().max(4000),
	status: ticketStatusSchema,
	createdAt: z.iso.datetime(),
	archivedAt: z.iso.datetime().optional(),
	needsAttention: z.literal(true).optional(),
	agentStatus: z.enum(["queued", "working"]).optional(),
});
export const ticketsSchema = z.array(ticketSchema).max(1000);
export const ticketWorkflowSchema = z.strictObject({
	ticketId: ticketIdSchema,
	workspaceId: z.uuid().optional(),
	plannerId: z.uuid().optional(),
	implementerId: z.uuid().optional(),
	phase: z.enum(["planning", "implementation", "review", "rebase"]),
	state: z.enum(["idle", "queued", "dispatching", "running", "merge-queued", "setup-failed", "failed", "uncertain"]),
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
export type { Ticket, TicketStatus, CreateTicket, MoveTicket } from "./types.ts";
export * from "./board-settings.ts";
