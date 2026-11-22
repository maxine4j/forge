import type { ForgeSettings } from "@forge/contracts/settings";
import { renderTicketPlan, resolveTicketWorkflowPreset, type Ticket } from "@forge/contracts/tickets";

import { ticketPlanGuidance, ticketSinglePlanGuidance } from "./ticket-plan-format.ts";
import type { TicketWorkflowRecord } from "./types.ts";

type TicketInstructions = Pick<ForgeSettings, "planningInstructions" | "implementationInstructions">;

export interface ITicketPrompts {
	build(ticket: Ticket, job: TicketWorkflowRecord): string;
}
export class TicketPrompts implements ITicketPrompts {
	constructor(private readonly instructions?: () => TicketInstructions) {}

	build(ticket: Ticket, job: TicketWorkflowRecord): string {
		const guidance =
			resolveTicketWorkflowPreset(ticket.executionSettings) === "planner-subtasks"
				? ticketPlanGuidance
				: ticketSinglePlanGuidance;
		const prompt = this.scope(ticket, job) + (job.phase === "planning" ? `\n\n${guidance}` : "");
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
		if (
			job.plan
			&& resolveTicketWorkflowPreset(ticket.executionSettings) === "planner-subtasks"
			&& job.plan.structured?.subtasks.length
		) {
			const task = job.plan.structured.subtasks[job.subtaskIndex ?? 0];
			if (task)
				return `Implement only subtask ${task.number}: ${task.title} from the approved plan below. Commit your changes on this branch. Earlier subtasks may already be complete; leave later subtasks for subsequent implementers.${this.extra(instructions?.implementationInstructions)}\n\n${renderTicketPlan(job.plan.structured)}`;
		}
		if (job.plan)
			return `Implement the approved plan below and commit the changes on this branch.${this.extra(instructions?.implementationInstructions)}\n\n${job.plan.structured ? renderTicketPlan(job.plan.structured) : job.plan.text}`;
		return `Implement ${ticket.id} ${ticket.title} and commit the changes on this worktree branch.\n\n${ticket.description}${this.extra(instructions?.implementationInstructions)}`;
	}

	private extra(instructions: string | undefined): string {
		return instructions?.trim() ? `\n\n${instructions}` : "";
	}
}
