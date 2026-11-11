import type { ForgeSettings } from "@forge/contracts/settings";
import type { Ticket, TicketWorkflow } from "@forge/contracts/tickets";

type TicketInstructions = Pick<ForgeSettings, "planningInstructions" | "implementationInstructions">;

export interface ITicketPrompts {
	build(ticket: Ticket, job: TicketWorkflow): string;
}
export class TicketPrompts implements ITicketPrompts {
	constructor(private readonly instructions?: () => TicketInstructions) {}

	build(ticket: Ticket, job: TicketWorkflow): string {
		if (job.message) return job.message;
		if (job.phase === "rebase") return "Rebase this branch onto the latest local main and resolve any conflicts.";
		const instructions = this.instructions?.();
		if (job.phase === "planning")
			return `Propose an implementation plan for ${ticket.id} ${ticket.title}${ticket.description ? `. ${ticket.description}` : "."}${this.extra(instructions?.planningInstructions)}`;
		return `Implement the approved plan below and commit the changes on this branch.${this.extra(instructions?.implementationInstructions)}\n\n${job.plan?.text ?? ""}`;
	}

	private extra(instructions: string | undefined): string {
		return instructions?.trim() ? `\n\n${instructions}` : "";
	}
}
