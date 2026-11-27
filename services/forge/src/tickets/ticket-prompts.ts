import type { ForgeSettings } from "@forge/contracts/settings";
import { renderTicketPlan, resolveTicketWorkflowPreset, ticketPlanLabels, type Ticket } from "@forge/contracts/tickets";

import { completionReportRequirements, handoffRequestTokens, reportTextLimit } from "./completion-report.ts";
import { ticketPlanGuidance, ticketSinglePlanGuidance } from "./ticket-plan-format.ts";
import type { TicketWorkflowRecord } from "./types.ts";

type TicketInstructions = Pick<ForgeSettings, "planningInstructions" | "implementationInstructions">;

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

export function ticketCompletionInstructions(requirements = completionReportRequirements()): string {
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
		requirements.handoff || requirements.complete.some(({ bounded }) => bounded)
			? " In handover or the next-subtask summary, retain concise progress, next actions, decisions, blockers, and verification results as applicable. Omit code dumps, long logs, and repeated plan text."
			: "";
	const checkpoint = requirements.handoff ? " Report handoff only after committing a safe checkpoint." : "";
	return `End your final answer with exactly one JSON object, without Markdown fences or surrounding prose. Use only the fields shown for your outcome. ${outcomes.join(" ")} Report complete only after finishing your assigned scope and committing the required changes.${checkpoint}${guidance}`;
}

export function ticketFinalizationPrompt(requirements: ReturnType<typeof completionReportRequirements>): string {
	const question = requirements.incomplete
		? "Assess the assignment against the work already done."
		: "Using the conversation, assess whether this assignment is complete or needs a handoff.";
	return `${question} Do not edit files or commit. Return only the explicit verdict. ${ticketCompletionInstructions(requirements)}`;
}

export interface ITicketPrompts {
	build(ticket: Ticket, job: TicketWorkflowRecord, includeCompletion?: boolean): string;
}
export class TicketPrompts implements ITicketPrompts {
	constructor(private readonly instructions?: () => TicketInstructions) {}

	build(ticket: Ticket, job: TicketWorkflowRecord, includeCompletion = true): string {
		const guidance =
			resolveTicketWorkflowPreset(ticket.executionSettings) === "planner-subtasks"
				? ticketPlanGuidance
				: ticketSinglePlanGuidance;
		const prompt =
			this.scope(ticket, job)
			+ (job.phase === "planning"
				? `\n\n${guidance}`
				: includeCompletion
					? `\n\n${ticketCompletionInstructions(completionReportRequirements(false, hasNextSubtask(ticket, job)))}`
					: "");
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
