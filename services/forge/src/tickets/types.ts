import { ticketWorkflowSchema, type TicketWorkflow } from "@forge/contracts/tickets";
import { z } from "zod";

import { providerSnapshotSchema } from "../model-providers/types.ts";

export const ticketWorkflowRecordSchema = ticketWorkflowSchema.extend({
	planningProviderSnapshot: providerSnapshotSchema.optional(),
	implementationProviderSnapshot: providerSnapshotSchema.optional(),
	reservation: z.string().min(1).optional(),
	previousTurnId: z.string().min(1).max(256).optional(),
	reportRetrySourceTurnId: z.string().min(1).max(256).optional(),
	subtaskIndex: z.number().int().nonnegative().optional(),
	turnId: z.string().min(1).max(256).optional(),
	context: z
		.object({
			prompt: z.string().optional(),
			handover: z.string().optional(),
			previousSubtaskSummary: z.string().optional(),
			baseline: z.string().optional(),
			workTurn: z.string().optional(),
			attempted: z.string().optional(),
			crossedTurnId: z.string().optional(),
			insufficient: z.boolean().optional(),
			checkpoint: z.string().optional(),
			stage: z.enum(["work", "report"]),
		})
		.optional(),
	workspaceCleaned: z.literal(true).optional(),
	cleanupFailed: z.literal(true).optional(),
	manualMergeSha: ticketWorkflowSchema.shape.resultSha,
	manualCleanupThreads: z.array(z.uuid()).optional(),
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
	reportRetrySourceTurnId: _retry,
	subtaskIndex: _subtaskIndex,
	turnId: _turn,
	context: _context,
	workspaceCleaned: _cleaned,
	cleanupFailed: _cleanupFailed,
	manualMergeSha: _manualMergeSha,
	manualCleanupThreads,
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
		...(manualCleanupThreads && !_cleaned && { cleanupPending: true as const }),
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
