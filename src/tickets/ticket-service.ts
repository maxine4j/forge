import {
	createTicketSchema,
	moveTicketSchema,
	ticketIdSchema,
	type CreateTicket,
	type MoveTicket,
	type Ticket,
} from "@forge/contracts/tickets";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { IEpicStore } from "../epics/epic-store.ts";
import type { IProjectStore } from "../projects/project-store.ts";
import { TicketError } from "./errors.ts";
import type { ITicketStore } from "./ticket-store.ts";
import type { ITicketWorkflowService } from "./ticket-workflow-service.ts";

export interface ITicketService {
	/** Existing owner access applies. Invalid input, missing tickets and invalid destinations throw TicketError. */
	list(actor: Actor): Promise<Ticket[]>;
	create(actor: Actor, input: CreateTicket): Promise<Ticket>;
	get(actor: Actor, id: string): Promise<Ticket>;
	update(actor: Actor, id: string, input: CreateTicket): Promise<Ticket>;
	/** Hides the ticket from the board and returns its retained data. */
	archive(actor: Actor, id: string): Promise<Ticket>;
	/** Workflow guards apply to every move; done is scheduler-owned. */
	move(actor: Actor, id: string, input: MoveTicket): Promise<Ticket>;
}
export class TicketService implements ITicketService {
	private tail: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly store: ITicketStore,
		private readonly projects: IProjectStore,
		private readonly access: IAccessService,
		private readonly now: () => Date,
		private readonly workflow: ITicketWorkflowService,
		private readonly epics: Pick<IEpicStore, "get">,
	) {}
	async list(actor: Actor): Promise<Ticket[]> {
		this.access.assertOwner(actor);
		const [tickets, summary] = await Promise.all([this.store.list(), this.workflow.boardSummary(actor)]);
		return tickets.map((ticket) => {
			if (ticket.status === "backlog" || ticket.status === "done") return ticket;
			return {
				...ticket,
				...(summary.get(ticket.id) ?? (ticket.status === "todo" ? { agentStatus: "queued" as const } : {})),
			};
		});
	}
	async create(actor: Actor, input: CreateTicket): Promise<Ticket> {
		this.access.assertOwner(actor);
		const parsed = createTicketSchema.safeParse(input);
		if (!parsed.success) throw new TicketError("invalid-request");
		return this.serialize(async () => {
			await this.requireReferences(parsed.data.repositoryIds);
			await this.requireEpic(parsed.data.epicId);
			if (parsed.data.executionSettings)
				await this.workflow.validateSettings(actor, parsed.data.executionSettings);
			return this.store.insert(parsed.data, this.now().toISOString());
		});
	}
	async get(actor: Actor, id: string): Promise<Ticket> {
		this.access.assertOwner(actor);
		if (!ticketIdSchema.safeParse(id).success) throw new TicketError("invalid-request");
		const ticket = await this.store.get(id);
		if (!ticket) throw new TicketError("ticket-not-found");
		return ticket;
	}
	async update(actor: Actor, id: string, input: CreateTicket): Promise<Ticket> {
		this.access.assertOwner(actor);
		const parsed = createTicketSchema.safeParse(input);
		if (!parsed.success || parsed.data.executionSettings !== undefined) throw new TicketError("invalid-request");
		return this.serialize(async () => {
			const ticket = await this.get(actor, id);
			if (ticket.archivedAt || ticket.status !== "backlog") throw new TicketError("ticket-conflict");
			await this.requireReferences(parsed.data.repositoryIds);
			await this.requireEpic(parsed.data.epicId);
			await this.workflow.update(actor, id, parsed.data);
			return this.get(actor, id);
		});
	}
	async archive(actor: Actor, id: string): Promise<Ticket> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const ticket = await this.get(actor, id);
			if (ticket.archivedAt) return ticket;
			await this.workflow.archive(actor, ticket, this.now().toISOString());
			return this.get(actor, id);
		});
	}
	async move(actor: Actor, id: string, input: MoveTicket): Promise<Ticket> {
		this.access.assertOwner(actor);
		const parsed = moveTicketSchema.safeParse(input);
		if (!parsed.success) throw new TicketError("invalid-request");
		return this.serialize(async () => {
			const ticket = await this.get(actor, id);
			if (ticket.archivedAt) throw new TicketError("ticket-conflict");
			if (parsed.data.beforeId) {
				const target = await this.store.get(parsed.data.beforeId);
				if (!target || target.archivedAt || target.id === id || target.status !== parsed.data.status)
					throw new TicketError("ticket-conflict");
			}
			await this.workflow.move(actor, ticket, parsed.data);
			return this.get(actor, id);
		});
	}
	private async requireReferences(ids: string[]): Promise<void> {
		for (const id of ids) if (!(await this.projects.get(id))) throw new TicketError("invalid-request");
	}
	private async requireEpic(id: string | null | undefined): Promise<void> {
		if (id && !(await this.epics.get(id))) throw new TicketError("invalid-request");
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.tail.then(operation);
		this.tail = next.catch(() => {});
		return next;
	}
}
