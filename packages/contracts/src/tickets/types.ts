export type TicketStatus = "backlog" | "todo" | "in-progress" | "in-review" | "merging" | "done";
export interface CreateTicket {
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
}
