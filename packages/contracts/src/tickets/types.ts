export type TicketStatus = "backlog" | "todo" | "in-progress" | "done";
export interface CreateTicket {
	executionSettings?: import("../agents/types.ts").AgentSettings;
	title: string;
	description: string;
}
export interface MoveTicket {
	status: TicketStatus;
	beforeId?: string;
}
export interface Ticket extends CreateTicket {
	id: string;
	projectId: string;
	status: TicketStatus;
	createdAt: string;
	archivedAt?: string;
	needsAttention?: true;
	agentStatus?: "queued" | "working";
}
