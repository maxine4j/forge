export type TicketStatus = "backlog" | "todo" | "in-progress" | "done";
export interface CreateTicket {
	repositoryIds?: string[];
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
	repositoryIds: string[];
	status: TicketStatus;
	createdAt: string;
	archivedAt?: string;
	needsAttention?: true;
	agentStatus?: "queued" | "working";
}
