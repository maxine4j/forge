import type { Ticket, TicketWorkflow } from "@forge/contracts/tickets";
import { expect, test } from "vitest";

import { TicketPrompts } from "./ticket-prompts.ts";

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
		"Propose an implementation plan for TASK-1 Search files. Filter by extension.",
	);
	const plan = { revision: 2, text: "# Plan\nFilter by extension." };
	expect(prompts.build(ticket, { ...job, phase: "implementation", plan })).toBe(
		"Implement the approved plan below and commit the changes on this branch.\n\n# Plan\nFilter by extension.",
	);
	expect(prompts.build(ticket, { ...job, phase: "rebase", plan })).toBe(
		"Rebase this branch onto the latest local main and resolve any conflicts.",
	);
	for (const phase of ["planning", "implementation", "rebase"] as const)
		expect(prompts.build(ticket, { ...job, phase, plan, message: "Include hidden files" })).toBe(
			"Include hidden files",
		);
	const configured = new TicketPrompts(() => ({
		planningInstructions: "List the risks.\nConsider migrations.",
		implementationInstructions: "Run focused tests.",
	}));
	expect(configured.build(ticket, job)).toBe(
		"Propose an implementation plan for TASK-1 Search files. Filter by extension.\n\nList the risks.\nConsider migrations.",
	);
	expect(configured.build(ticket, { ...job, phase: "implementation", plan })).toBe(
		"Implement the approved plan below and commit the changes on this branch.\n\nRun focused tests.\n\n# Plan\nFilter by extension.",
	);
	expect(configured.build(ticket, { ...job, message: "Include hidden files" })).toBe("Include hidden files");
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
