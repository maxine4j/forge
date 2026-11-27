import type { Ticket, TicketWorkflow } from "@forge/contracts/tickets";
import { expect, test } from "vitest";

import {
	ticketPlanGuidance as subtaskGuidance,
	ticketSinglePlanGuidance as ticketPlanGuidance,
} from "./ticket-plan-format.ts";
import { TicketPrompts, ticketCompletionInstructions } from "./ticket-prompts.ts";

test("initial phase prompts include only the scope needed for that phase and followups are verbatim", () => {
	const prompts = new TicketPrompts();
	const ticket: Ticket = {
		id: "TASK-1",
		repositoryIds: ["123e4567-e89b-42d3-a456-426614174000"],
		title: "Search files",
		description: "Filter by extension.",
		status: "in-progress",
		createdAt: "2026-11-03T00:00:00.000Z",
	};
	const job: TicketWorkflow = { ticketId: ticket.id, phase: "planning", state: "queued", mergeAttempts: 0 };
	expect(prompts.build(ticket, job)).toBe(
		`Propose an implementation plan for TASK-1 Search files. Filter by extension.\n\n${ticketPlanGuidance}`,
	);
	expect(prompts.build({ ...ticket, executionSettings: { workflowPreset: "planner-subtasks" } }, job)).toContain(
		subtaskGuidance,
	);
	const plan = { revision: 2, text: "# Plan\nFilter by extension." };
	const structured = {
		goals: "Goals body",
		scope: "Scope body",
		decisions: "Decisions body",
		acceptanceCriteria: "Criteria body",
		tests: "Tests body",
		subtasks: [
			{
				number: 1,
				title: "First",
				files: "a.ts",
				dependencies: "None",
				expectedChanges: "Change",
				exclusions: "None",
				completionCriteria: "Done",
			},
			{
				number: 2,
				title: "Second",
				files: "b.ts",
				dependencies: "1",
				expectedChanges: "More",
				exclusions: "None",
				completionCriteria: "Done",
			},
		],
	};
	const rebuilt = prompts.build(ticket, { ...job, phase: "implementation", plan: { ...plan, structured } });
	expect(rebuilt).not.toContain("Filter by extension.");
	expect(rebuilt).toMatch(
		/## Goals[\s\S]*## Scope[\s\S]*## Decisions[\s\S]*## Acceptance criteria[\s\S]*## Tests[\s\S]*### 1\. First[\s\S]*### 2\. Second/,
	);
	expect(prompts.build(ticket, { ...job, phase: "implementation", plan })).toBe(
		`Implement the approved plan below and commit the changes on this branch.\n\n# Plan\nFilter by extension.\n\n${ticketCompletionInstructions()}`,
	);
	expect(prompts.build(ticket, { ...job, phase: "rebase", plan })).toBe(
		`Rebase this branch onto the latest local main and resolve any conflicts.\n\n${ticketCompletionInstructions()}`,
	);
	for (const phase of ["implementation", "rebase"] as const)
		expect(prompts.build(ticket, { ...job, phase, plan, message: "Include hidden files" })).toBe(
			`Include hidden files\n\n${ticketCompletionInstructions()}`,
		);
	const configured = new TicketPrompts(() => ({
		planningInstructions: "List the risks.\nConsider migrations.",
		implementationInstructions: "Run focused tests.",
	}));
	expect(configured.build(ticket, job)).toBe(
		`Propose an implementation plan for TASK-1 Search files. Filter by extension.\n\nList the risks.\nConsider migrations.\n\n${ticketPlanGuidance}`,
	);
	expect(configured.build(ticket, { ...job, phase: "implementation", plan })).toBe(
		`Implement the approved plan below and commit the changes on this branch.\n\nRun focused tests.\n\n# Plan\nFilter by extension.\n\n${ticketCompletionInstructions()}`,
	);
	expect(configured.build(ticket, { ...job, message: "Include hidden files" })).toBe(
		`Include hidden files\n\nProvide a complete replacement native plan incorporating this feedback.\n\n${ticketPlanGuidance}`,
	);
	expect(configured.build(ticket, { ...job, phase: "rebase" })).toBe(
		prompts.build(ticket, { ...job, phase: "rebase" }),
	);
	const direct = configured.build(ticket, { ...job, phase: "implementation" });
	expect(direct).toContain("TASK-1 Search files");
	expect(direct).toContain("Filter by extension.");
	expect(direct).toContain("Run focused tests.");
	expect(direct).toContain("commit the changes on this worktree branch");
	expect(direct).not.toContain("approved plan");
	for (const phase of ["planning", "implementation", "rebase"] as const) {
		for (const message of [undefined, "Owner feedback"]) {
			const recommended = configured.build(
				{ ...ticket, executionSettings: { acceptRecommendations: true } },
				{ ...job, phase, message },
			);
			expect(recommended).toContain("Choose the recommended option");
			expect(recommended).toContain("without asking the owner preference or clarification questions");
			expect(recommended).toContain("Retain manual plan approval and the selected tool permission mode");
			if (message) expect(recommended).toMatch(/^Owner feedback/);
		}
	}
});
