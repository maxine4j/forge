import { ticketWorkflowSchema } from "@forge/contracts/tickets";
import { z } from "zod";

export const ticketWorkflowRecordSchema = ticketWorkflowSchema.extend({
	previousTurnId: z.string().min(1).max(256).optional(),
	turnId: z.string().min(1).max(256).optional(),
	workspaceCleaned: z.literal(true).optional(),
	abandonment: z
		.object({
			workspaceId: z.string().optional(),
			plannerId: z.string().optional(),
			implementerId: z.string().optional(),
		})
		.optional(),
});

export type TicketWorkflowRecord = z.infer<typeof ticketWorkflowRecordSchema>;
