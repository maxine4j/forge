import type { TicketStatus } from "@forge/contracts/tickets";

export const ticketLabels: Record<TicketStatus, string> = {
	backlog: "Backlog",
	todo: "Ready for development",
	"in-progress": "In progress",
	done: "Done",
};
