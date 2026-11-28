import { ticketWorkflowSchema } from "@forge/contracts/tickets";
import { expect, test } from "vitest";

import { normalizeTicketWorkflow, ticketWorkflowSummary } from "./types.ts";

test("public workflow preserves structured and legacy plans", () => {
	const structured = {
		title: "Plan",
		goals: "Goals",
		scope: "Scope",
		decisions: "Decisions",
		acceptanceCriteria: "Criteria",
		tests: "Tests",
		subtasks: [
			{
				number: 1,
				title: "First",
				files: "a",
				dependencies: "None",
				expectedChanges: "Change",
				exclusions: "None",
				completionCriteria: "Done",
			},
		],
	};
	for (const plan of [
		{ revision: 1, text: "Original" },
		{ revision: 2, text: "Revised", structured },
	]) {
		const record = normalizeTicketWorkflow({
			ticketId: "TASK-1",
			phase: "planning",
			state: "idle",
			mergeAttempts: 0,
			plan,
		});
		expect(ticketWorkflowSchema.parse(ticketWorkflowSummary(record)).plan).toEqual(plan);
	}
});

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

test("incomplete retry state is bounded, private, and optional for legacy records", () => {
	const legacy = { ticketId: "TASK-1", phase: "implementation", state: "running", mergeAttempts: 0 };
	expect(normalizeTicketWorkflow(legacy).incompleteRetry).toBeUndefined();
	for (const attempts of [0, 1, 3]) {
		const record = normalizeTicketWorkflow({
			...legacy,
			incompleteRetry: { threadId: "thread", attempts, pendingSourceTurnId: "turn" },
		});
		expect(record.incompleteRetry?.attempts).toBe(attempts);
		expect(ticketWorkflowSummary(record)).not.toHaveProperty("incompleteRetry");
	}
	for (const attempts of [-1, 4, 0.5])
		expect(() =>
			normalizeTicketWorkflow({ ...legacy, incompleteRetry: { threadId: "thread", attempts } }),
		).toThrow();
});
