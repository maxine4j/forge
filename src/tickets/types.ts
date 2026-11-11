import { ticketWorkflowSchema } from "@forge/contracts/tickets";
import { z } from "zod";

export const ticketWorkflowRecordSchema = ticketWorkflowSchema.extend({
	previousTurnId: z.string().min(1).max(256).optional(),
	turnId: z.string().min(1).max(256).optional(),
});

export type TicketWorkflowRecord = z.infer<typeof ticketWorkflowRecordSchema>;
