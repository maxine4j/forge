import type { Ticket, TicketWorkflow } from "@forge/contracts/tickets";

export interface ITicketPrompts {
	build(ticket: Ticket, job: TicketWorkflow): string;
}
export class TicketPrompts implements ITicketPrompts {
	build(ticket: Ticket, job: TicketWorkflow): string {
		if (job.message) return job.message;
		if (job.phase === "planning")
			return `Propose an implementation plan for ${ticket.id} ${ticket.title}${ticket.description ? `. ${ticket.description}` : "."}`;
		if (job.phase === "rebase") return "Rebase this branch onto the latest local main and resolve any conflicts.";
		return `Implement the approved plan below and commit the changes on this branch.\n\n${job.plan?.text ?? ""}`;
	}
}
