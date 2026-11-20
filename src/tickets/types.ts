import { ticketWorkflowSchema } from "@forge/contracts/tickets";
import { z } from "zod";

import { providerSnapshotSchema } from "../model-providers/types.ts";

export const ticketWorkflowRecordSchema = ticketWorkflowSchema.extend({
	providerSnapshot: providerSnapshotSchema.optional(),
	previousTurnId: z.string().min(1).max(256).optional(),
	turnId: z.string().min(1).max(256).optional(),
	workspaceCleaned: z.literal(true).optional(),
	cleanupFailed: z.literal(true).optional(),
	abandonment: z
		.object({
			workspaceId: z.string().optional(),
			plannerId: z.string().optional(),
			implementerId: z.string().optional(),
		})
		.optional(),
});

export type TicketWorkflowRecord = z.infer<typeof ticketWorkflowRecordSchema>;
