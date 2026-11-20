import { expect, test } from "vitest";

import { normalizeTicketWorkflow, ticketWorkflowSummary } from "./types.ts";

test("legacy snapshots normalize both phases and public projections expose only phase identities", () => {
	const snapshot = {
		providerId: "123e4567-e89b-42d3-a456-426614174000",
		providerName: "Historical",
		configuration: { kind: "ollama", endpoint: "http://historical/v1", model: "original" },
	};
	const record = normalizeTicketWorkflow({
		ticketId: "TASK-1",
		phase: "implementation",
		state: "uncertain",
		mergeAttempts: 0,
		providerSnapshot: snapshot,
		turnId: "private-turn",
	});
	expect(record.planningProviderSnapshot).toEqual(snapshot);
	expect(record.implementationProviderSnapshot).toEqual(snapshot);
	const publicRecord = ticketWorkflowSummary(record);
	for (const phase of ["planningProvider", "implementationProvider"] as const)
		expect(publicRecord[phase]).toEqual({
			providerId: snapshot.providerId,
			providerName: "Historical",
			providerLocked: true,
		});
	for (const privateValue of ["http://", "configuration", "Snapshot", "private-turn"])
		expect(JSON.stringify(publicRecord)).not.toContain(privateValue);
	expect(normalizeTicketWorkflow(record)).toEqual(record);
});
