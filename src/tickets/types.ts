import { ticketWorkflowSchema, type TicketWorkflow } from "@forge/contracts/tickets";
import { z } from "zod";

import { providerSnapshotSchema } from "../model-providers/types.ts";

export const ticketWorkflowRecordSchema = ticketWorkflowSchema.extend({
	planningProviderSnapshot: providerSnapshotSchema.optional(),
	implementationProviderSnapshot: providerSnapshotSchema.optional(),
	reservation: z.string().min(1).optional(),
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

/** One public projection for workflow reads and notification payloads. */
export function ticketWorkflowSummary({
	previousTurnId: _previous,
	turnId: _turn,
	workspaceCleaned: _cleaned,
	cleanupFailed: _cleanupFailed,
	abandonment: _abandonment,
	planningProviderSnapshot,
	implementationProviderSnapshot,
	reservation: _reservation,
	...workflow
}: TicketWorkflowRecord): TicketWorkflow {
	const identity = (snapshot: TicketWorkflowRecord["planningProviderSnapshot"]) =>
		snapshot && {
			providerId: snapshot.providerId,
			providerName: snapshot.providerName,
			providerLocked: true as const,
		};
	return {
		...workflow,
		plan: workflow.plan && {
			revision: workflow.plan.revision,
			text: workflow.plan.text,
			...(workflow.plan.structured && { structured: workflow.plan.structured }),
		},
		planningProvider: identity(planningProviderSnapshot),
		implementationProvider: identity(implementationProviderSnapshot),
	};
}

/** Normalize attempt-wide routing before any recovery or subsequent save. */
export function normalizeTicketWorkflow(input: unknown): TicketWorkflowRecord {
	const legacy = z.object({ providerSnapshot: providerSnapshotSchema.optional() }).parse(input);
	const {
		providerSnapshot: _legacy,
		providerId: _id,
		providerName: _name,
		providerLocked: _locked,
		...rest
	} = input as Record<string, unknown>;
	const record = ticketWorkflowRecordSchema.parse(rest);
	if (legacy.providerSnapshot) {
		record.planningProviderSnapshot ??= legacy.providerSnapshot;
		record.implementationProviderSnapshot ??= legacy.providerSnapshot;
	}
	return record;
}
