import type { ForgeSettings } from "@forge/contracts/settings";
import { renderTicketPlan, resolveTicketWorkflowPreset, ticketPlanLabels, type Ticket } from "@forge/contracts/tickets";

import { completionReportRequirements, handoffRequestTokens, reportTextLimit } from "./completion-report.ts";
import { ticketPlanGuidance, ticketSinglePlanGuidance } from "./ticket-plan-format.ts";
import type { TicketWorkflowRecord } from "./types.ts";

type TicketInstructions = Pick<ForgeSettings, "planningInstructions" | "implementationInstructions">;
const completionInstruction =
	"Report complete only when the full assignment is finished and the required changes are committed. Assess the full assignment even when the latest request is a diagnostic or recovery instruction.";
const checkpointRequirement =
	" Report handoff only if the work turn created a new safe checkpoint commit. If the assignment is unfinished and there is no new safe checkpoint, report incomplete and list what remains.";
const checkpointInstruction = ` For a handoff, commit only existing uncommitted assignment changes if a safe checkpoint is immediately possible.${checkpointRequirement}`;
const legacyCompletionInstruction =
	"Report complete only after finishing your assigned scope and committing the required changes.";
const legacyCheckpointInstruction = " Report handoff only after committing a safe checkpoint.";
const legacyEmergencyCheckpointInstruction =
	" For a handoff, commit only existing uncommitted assignment changes if a safe checkpoint is immediately possible. Report promptly if there are no changes to commit or the checkpoint is blocked.";

const emergencyHandoffInstruction =
	"Use only what you already know. Choose complete only if the assignment is ready to advance or merge. Otherwise choose handoff, including when you were still investigating or there is no new checkpoint. In the handover, briefly state what changed, what is committed or unsaved, which verification finished, and what the next agent should do.";

export function emergencyHandoverSteer(hasNextSubtask: boolean): string {
	const report = renderCompletionInstructions(
		completionReportRequirements(hasNextSubtask, true),
		completionInstruction,
		"",
	);
	return `EMERGENCY: You MUST stop all work IMMEDIATELY!
You are running critically low on context. One more operation could exhaust it and cut off this handover. This emergency instruction overrides earlier directions to finish the assignment, verify it, or wait for a checkpoint before reporting.

You MUST NOT finish the current operation, even if it is almost done. You MUST NOT read another file, make another edit, finish or wait for a test run, start another test or build, check the result of a running command, investigate a failure, or reread earlier instructions. Stop now, even if you believe the assignment is already complete.

The only tool actions allowed are the Git status, staging, and commit commands strictly needed to save assignment changes you already made. If you have uncommitted assignment changes and can safely checkpoint them now, commit only those changes on the current branch. If there are no uncommitted assignment changes, including when you already committed your work, skip the commit. Never create an empty commit. If a safe commit is blocked or fails, stop immediately and report what is unsaved. Do not retry, fix, or investigate it.

${report} ${emergencyHandoffInstruction}`;
}

export function assignedSubtask(ticket: Ticket, job: TicketWorkflowRecord) {
	if (job.phase === "implementation" && resolveTicketWorkflowPreset(ticket.executionSettings) === "planner-subtasks")
		return job.plan?.structured?.subtasks[job.subtaskIndex ?? 0];
	return undefined;
}

export function hasNextSubtask(ticket: Ticket | undefined, job: TicketWorkflowRecord): boolean {
	return (
		job.phase === "implementation"
		&& resolveTicketWorkflowPreset(ticket?.executionSettings) === "planner-subtasks"
		&& (job.subtaskIndex ?? 0) + 1 < (job.plan?.structured?.subtasks.length ?? 0)
	);
}

type CompletionRequirements = ReturnType<typeof completionReportRequirements>;

export function ticketCompletionInstructions(requirements = completionReportRequirements()): string {
	return renderCompletionInstructions(requirements, completionInstruction, checkpointInstruction);
}

function renderCompletionInstructions(
	requirements: { [Status in keyof CompletionRequirements]: CompletionRequirements[Status] | undefined },
	completion: string,
	checkpoint: string,
): string {
	const outcomes = Object.entries(requirements).flatMap(([status, fields]) => {
		if (!fields) return [];
		const example = JSON.stringify({ status, ...Object.fromEntries(fields.map(({ name }) => [name, "…"])) });
		const descriptions = fields.map(({ name, required, bounded }) => {
			const limit = bounded
				? `at most ${handoffRequestTokens.toLocaleString("en-US")} tokens`
				: `at most ${reportTextLimit.toLocaleString("en-US")} characters`;
			return `${name} is ${required ? "required" : "optional"} and must be nonblank text of ${limit}`;
		});
		return [`${example} (${descriptions.join(". ")}).`];
	});
	const guidance =
		requirements.handoff || requirements.complete?.some(({ bounded }) => bounded)
			? " In handover or the next-subtask summary, retain concise progress, next actions, decisions, blockers, and verification results as applicable. Omit code dumps, long logs, and repeated plan text."
			: "";
	return `End your final answer with exactly one JSON object, without Markdown fences or surrounding prose. Use only the fields shown for your outcome. ${outcomes.join(" ")} ${completion}${requirements.handoff ? checkpoint : ""}${guidance}`;
}

export function ticketFinalizationPrompt(requirements: CompletionRequirements, emergency = false): string {
	const report = renderCompletionInstructions(
		requirements,
		completionInstruction,
		emergency ? ` ${emergencyHandoffInstruction}` : checkpointRequirement,
	);
	return `Assess the full assignment against the work already done. Do not edit files or commit. Return only the explicit verdict. ${report}`;
}

// Older assignments could persist the rendered paragraph, including variants
// that allowed handoff only for checkpoints.
const completionBlocks = new Set([
	'End your final answer with exactly one JSON object, without Markdown fences or surrounding prose: {"status":"complete","summary":"Implemented and verified the assignment"} or {"status":"incomplete","remaining":"Still need to finish the integration tests"}. Summary is optional; remaining is required only for incomplete. Text must be nonblank and at most 2,000 characters. Report complete only after finishing your assigned scope and committing the required changes.',
	...[false, true].flatMap((hasNext) => {
		const work = completionReportRequirements(hasNext);
		const checkpoint = { ...work, incomplete: undefined };
		const legacyReportInstruction = legacyCompletionInstruction.replace(" and committing the required changes", "");
		return [
			ticketCompletionInstructions(work),
			renderCompletionInstructions(work, completionInstruction, checkpointRequirement),
			...[work, checkpoint].flatMap((requirements) => [
				renderCompletionInstructions(requirements, legacyCompletionInstruction, legacyCheckpointInstruction),
				renderCompletionInstructions(
					requirements,
					legacyCompletionInstruction,
					legacyEmergencyCheckpointInstruction,
				),
				renderCompletionInstructions(requirements, legacyReportInstruction, ""),
			]),
			renderCompletionInstructions(checkpoint, legacyCompletionInstruction, ""),
			renderCompletionInstructions({ ...work, handoff: undefined }, legacyCompletionInstruction, ""),
		];
	}),
]);

export function cleanTicketAssignment(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const retained = text.split(/(?<=\n)/).filter((line) => !completionBlocks.has(line.trim()));
	return retained.join("").trim() || undefined;
}

export function ticketFreshWorkPrompt(
	ticket: Ticket,
	job: TicketWorkflowRecord,
	assignment: string,
	recovery?: string,
	interrupted = false,
): string {
	return [
		assignment,
		interrupted
			? "The previous run may have left partial work in this worktree. Inspect the current changes and commits before continuing."
			: undefined,
		recovery && `Recovery instruction:\n${recovery}`,
		job.context?.handover && `Handover:\n${job.context.handover}`,
		job.context?.handover && !interrupted && "Inspect the current changes and commits before continuing.",
		job.context?.previousSubtaskSummary && `Previous subtask summary:\n${job.context.previousSubtaskSummary}`,
		ticketCompletionInstructions(completionReportRequirements(hasNextSubtask(ticket, job))),
	]
		.filter(Boolean)
		.join("\n\n");
}

export interface ITicketPrompts {
	planning(ticket: Ticket, job: TicketWorkflowRecord): string;
	assignment(ticket: Ticket, job: TicketWorkflowRecord): string;
}
export class TicketPrompts implements ITicketPrompts {
	constructor(private readonly instructions?: () => TicketInstructions) {}

	planning(ticket: Ticket, job: TicketWorkflowRecord): string {
		const guidance =
			resolveTicketWorkflowPreset(ticket.executionSettings) === "planner-subtasks"
				? ticketPlanGuidance
				: ticketSinglePlanGuidance;
		return this.withRecommendations(ticket, `${this.scope(ticket, job)}\n\n${guidance}`);
	}

	assignment(ticket: Ticket, job: TicketWorkflowRecord): string {
		return this.withRecommendations(ticket, this.scope(ticket, job));
	}

	private withRecommendations(ticket: Ticket, prompt: string): string {
		return ticket.executionSettings?.acceptRecommendations
			? `${prompt}\n\nChoose the recommended option, make reasonable assumptions, and proceed without asking the owner preference or clarification questions or asking them to select or confirm an approach. Retain manual plan approval and the selected tool permission mode.`
			: prompt;
	}

	private scope(ticket: Ticket, job: TicketWorkflowRecord): string {
		if (job.message)
			return job.phase === "planning"
				? `${job.message}\n\nProvide a complete replacement native plan incorporating this feedback.`
				: job.message;
		if (job.phase === "rebase") return "Rebase this branch onto the latest local main and resolve any conflicts.";
		const instructions = this.instructions?.();
		if (job.phase === "planning")
			return `Propose an implementation plan for ${ticket.id} ${ticket.title}${ticket.description ? `. ${ticket.description}` : "."}${this.extra(instructions?.planningInstructions)}`;
		const task = assignedSubtask(ticket, job);
		if (task) {
			const fields = [
				task.files,
				task.dependencies,
				task.expectedChanges,
				task.exclusions,
				task.completionCriteria,
			];
			return `Implement only subtask ${task.number}: ${task.title}. Commit your changes on this branch.${this.extra(instructions?.implementationInstructions)}\n\n${fields.map((value, i) => `- ${ticketPlanLabels[i]}: ${value}`).join("\n")}`;
		}
		if (job.plan)
			return `Implement the approved plan below and commit the changes on this branch.${this.extra(instructions?.implementationInstructions)}\n\n${job.plan.structured ? renderTicketPlan(job.plan.structured) : job.plan.text}`;
		return `Implement ${ticket.id} ${ticket.title} and commit the changes on this worktree branch.\n\n${ticket.description}${this.extra(instructions?.implementationInstructions)}`;
	}

	private extra(instructions: string | undefined): string {
		return instructions?.trim() ? `\n\n${instructions}` : "";
	}
}
