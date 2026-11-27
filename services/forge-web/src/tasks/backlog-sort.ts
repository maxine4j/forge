import type { Ticket } from "@forge/contracts/tickets";

const statusRank: Record<Ticket["status"], number> = {
	"in-progress": 0,
	todo: 1,
	backlog: 2,
	done: 3,
};

const activityRank = (ticket: Ticket): number => {
	if (ticket.needsAttention) return 0;
	if (ticket.resetting) return 2;
	if (ticket.agentStatus === "working") return 1;
	if (ticket.agentStatus === "queued") return 2;
	return 3;
};

export const compareBacklogTickets = (a: Ticket, b: Ticket): number =>
	Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt))
	|| statusRank[a.status] - statusRank[b.status]
	|| activityRank(a) - activityRank(b)
	|| Number(a.id.slice(5)) - Number(b.id.slice(5));
