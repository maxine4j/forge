import type { Ticket, TicketWorkflow } from "@forge/contracts/tickets";
import { expect, test } from "vitest";

import { completionReportRequirements, parseCompletionReport } from "./completion-report.ts";
import {
	ticketPlanGuidance as subtaskGuidance,
	ticketSinglePlanGuidance as ticketPlanGuidance,
} from "./ticket-plan-format.ts";
import {
	cleanTicketAssignment,
	TicketPrompts,
	ticketCompletionInstructions,
	ticketFinalizationPrompt,
	ticketIncompleteContinuationPrompt,
} from "./ticket-prompts.ts";

test.each([false, true])(
	"incomplete continuation encourages work and includes reporting instructions (next=%s)",
	(next) => {
		const requirements = completionReportRequirements(next);
		const prompt = ticketIncompleteContinuationPrompt(requirements);
		expect(prompt).toContain(
			"You’ve made a start, and you can build on the work already in this chat and workspace.",
		);
		expect(prompt).toContain("Report completion once the full assignment is finished and verified.");
		expect(prompt.endsWith(ticketCompletionInstructions(requirements))).toBe(true);
		if (next) expect(prompt).toContain("summary is required");
	},
);

test("strips repeated exact historical completion blocks and preserves surrounding prose and partial quotations", () => {
	const original =
		'End your final answer with exactly one JSON object, without Markdown fences or surrounding prose: {"status":"complete","summary":"Implemented and verified the assignment"} or {"status":"incomplete","remaining":"Still need to finish the integration tests"}. Summary is optional; remaining is required only for incomplete. Text must be nonblank and at most 2,000 characters. Report complete only after finishing your assigned scope and committing the required changes.';
	const prefix =
		"End your final answer with exactly one JSON object, without Markdown fences or surrounding prose. Use only the fields shown for your outcome.";
	const complete =
		'{"status":"complete","summary":"…"} (summary is optional and must be nonblank text of at most 2,000 characters).';
	const bounded =
		'{"status":"complete","summary":"…"} (summary is required and must be nonblank text of at most 1,500 tokens).';
	const incomplete =
		'{"status":"incomplete","remaining":"…","summary":"…"} (remaining is required and must be nonblank text of at most 2,000 characters. summary is optional and must be nonblank text of at most 2,000 characters).';
	const handoff =
		'{"status":"handoff","handover":"…"} (handover is required and must be nonblank text of at most 1,500 tokens).';
	const finish = "Report complete only after finishing your assigned scope and committing the required changes.";
	const emergencyCheckpoint =
		"For a handoff, commit only existing uncommitted assignment changes if a safe checkpoint is immediately possible. Report promptly if there are no changes to commit or the checkpoint is blocked.";
	const guidance =
		"In handover or the next-subtask summary, retain concise progress, next actions, decisions, blockers, and verification results as applicable. Omit code dumps, long logs, and repeated plan text.";
	const blocks = [
		original,
		ticketCompletionInstructions(),
		ticketCompletionInstructions(completionReportRequirements(true)),
		...[complete, bounded].flatMap((outcome) => [
			`${prefix} ${outcome} ${incomplete} ${finish}${outcome === bounded ? ` ${guidance}` : ""}`,
			`${prefix} ${outcome} ${handoff} ${finish} ${guidance}`,
			`${prefix} ${outcome} ${incomplete} ${handoff} ${finish} Report handoff only after committing a safe checkpoint. ${guidance}`,
			`${prefix} ${outcome} ${handoff} ${finish} Report handoff only after committing a safe checkpoint. ${guidance}`,
			`${prefix} ${outcome} ${incomplete} ${handoff} ${finish} ${emergencyCheckpoint} ${guidance}`,
			`${prefix} ${outcome} ${handoff} ${finish} ${emergencyCheckpoint} ${guidance}`,
		]),
	];
	const retained = ["Verify the branch.", prefix, `Quoted inline: ${original}`, "Then run tests."];
	for (const block of blocks) {
		expect(cleanTicketAssignment(block)).toBeUndefined();
		expect(cleanTicketAssignment([retained[0], block, block, ...retained.slice(1)].join("\r\n"))).toBe(
			retained.join("\r\n"),
		);
	}
});

test("checkpoint guidance is conditional and report-only requests do not instruct commits", () => {
	const requirements = completionReportRequirements(true);
	expect(ticketCompletionInstructions(requirements)).toContain(
		"commit only existing uncommitted assignment changes if a safe checkpoint is immediately possible",
	);
	expect(ticketCompletionInstructions(requirements)).toContain(
		"If the assignment is unfinished and there is no new safe checkpoint, report incomplete",
	);
	const report = ticketFinalizationPrompt(requirements);
	expect(report).toContain("Do not edit files or commit");
	expect(report).not.toContain("commit only existing");
	expect(report).toContain("Report handoff only if the work turn created a new safe checkpoint commit");
});

test.each([false, true])("advertised report examples pass validation (has next subtask=%s)", (hasNextSubtask) => {
	const requirements = completionReportRequirements(hasNextSubtask);
	const examples = ticketCompletionInstructions(requirements).match(/\{"status":[^}]+\}/g);
	expect(examples).toContain('{"status":"handoff","handover":"…"}');
	expect(examples).toHaveLength(3);
	for (const example of examples!) expect(parseCompletionReport(example, requirements)).toBeDefined();
});

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
	expect(prompts.planning(ticket, job)).toBe(
		`Propose an implementation plan for TASK-1 Search files. Filter by extension.\n\n${ticketPlanGuidance}`,
	);
	expect(prompts.planning({ ...ticket, executionSettings: { workflowPreset: "planner-subtasks" } }, job)).toContain(
		subtaskGuidance,
	);
	const plan = { revision: 2, text: "# Plan\nFilter by extension." };
	const structured = {
		title: "Plan title marker",
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
				dependencies: "First dependency marker",
				expectedChanges: "First change marker",
				exclusions: "First exclusion marker",
				completionCriteria: "First completion marker",
			},
			{
				number: 2,
				title: "Second",
				files: "b.ts",
				dependencies: "Second dependency marker",
				expectedChanges: "Second change marker",
				exclusions: "Second exclusion marker",
				completionCriteria: "Second completion marker",
			},
		],
	};
	const rebuilt = prompts.assignment(ticket, { ...job, phase: "implementation", plan: { ...plan, structured } });
	expect(rebuilt).not.toContain("Filter by extension.");
	expect(rebuilt).toMatch(
		/## Goals[\s\S]*## Scope[\s\S]*## Decisions[\s\S]*## Acceptance criteria[\s\S]*## Tests[\s\S]*### 1\. First[\s\S]*### 2\. Second/,
	);
	expect(prompts.assignment(ticket, { ...job, phase: "implementation", plan })).toBe(
		`Implement the approved plan below and commit the changes on this branch.\n\n# Plan\nFilter by extension.`,
	);
	expect(prompts.assignment(ticket, { ...job, phase: "rebase", plan })).toBe(
		`Rebase this branch onto the latest local main and resolve any conflicts.`,
	);
	for (const phase of ["implementation", "rebase"] as const)
		expect(prompts.assignment(ticket, { ...job, phase, plan, message: "Include hidden files" })).toBe(
			`Include hidden files`,
		);
	const configured = new TicketPrompts(() => ({
		planningInstructions: "List the risks.\nConsider migrations.",
		implementationInstructions: "Run focused tests.",
	}));
	for (const [subtaskIndex, task] of structured.subtasks.entries()) {
		const scoped = configured.assignment(
			{ ...ticket, executionSettings: { workflowPreset: "planner-subtasks" } },
			{ ...job, phase: "implementation", plan: { ...plan, structured }, subtaskIndex },
		);
		expect(scoped).toBe(
			`Implement only subtask ${task.number}: ${task.title}. Commit your changes on this branch.\n\nRun focused tests.\n\n- Files: ${task.files}\n- Dependencies: ${task.dependencies}\n- Expected changes: ${task.expectedChanges}\n- Exclusions: ${task.exclusions}\n- Completion criteria: ${task.completionCriteria}`,
		);
	}
	expect(configured.planning(ticket, job)).toBe(
		`Propose an implementation plan for TASK-1 Search files. Filter by extension.\n\nList the risks.\nConsider migrations.\n\n${ticketPlanGuidance}`,
	);
	expect(configured.assignment(ticket, { ...job, phase: "implementation", plan })).toBe(
		`Implement the approved plan below and commit the changes on this branch.\n\nRun focused tests.\n\n# Plan\nFilter by extension.`,
	);
	expect(configured.planning(ticket, { ...job, message: "Include hidden files" })).toBe(
		`Include hidden files\n\nProvide a complete replacement native plan incorporating this feedback.\n\n${ticketPlanGuidance}`,
	);
	expect(configured.assignment(ticket, { ...job, phase: "rebase" })).toBe(
		prompts.assignment(ticket, { ...job, phase: "rebase" }),
	);
	const direct = configured.assignment(ticket, { ...job, phase: "implementation" });
	expect(direct).toContain("TASK-1 Search files");
	expect(direct).toContain("Filter by extension.");
	expect(direct).toContain("Run focused tests.");
	expect(direct).toContain("commit the changes on this worktree branch");
	expect(direct).not.toContain("approved plan");
	for (const phase of ["planning", "implementation", "rebase"] as const) {
		for (const message of [undefined, "Owner feedback"]) {
			const recommended = configured[phase === "planning" ? "planning" : "assignment"](
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
