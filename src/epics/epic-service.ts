import {
	editEpicSchema,
	epicIdSchema,
	type EditEpic,
	type EpicSummary,
	type EpicDetail,
	type Epic,
	type Ticket,
} from "@forge/contracts/tickets";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { ITicketStore } from "../tickets/ticket-store.ts";
import type { IEpicStore } from "./epic-store.ts";
import { EpicError } from "./errors.ts";

export interface IEpicService {
	list(actor: Actor): Promise<EpicSummary[]>;
	get(actor: Actor, id: string): Promise<EpicDetail>;
	create(actor: Actor, input: EditEpic): Promise<EpicDetail>;
	update(actor: Actor, id: string, input: EditEpic): Promise<EpicDetail>;
}
const summarize = (epic: Epic, children: Ticket[]): EpicSummary => {
	const counts = { backlog: 0, todo: 0, "in-progress": 0, done: 0 };
	for (const ticket of children) counts[ticket.status]++;
	return {
		...epic,
		counts,
		total: children.length,
		done: counts.done,
		complete: children.length > 0 && counts.done === children.length,
	};
};
export class EpicService implements IEpicService {
	constructor(
		private readonly store: IEpicStore,
		private readonly tickets: ITicketStore,
		private readonly access: IAccessService,
		private readonly now: () => Date,
	) {}
	async list(actor: Actor): Promise<EpicSummary[]> {
		this.access.assertOwner(actor);
		const [epics, tickets] = await Promise.all([this.store.list(), this.tickets.list()]);
		return epics.map((epic) =>
			summarize(
				epic,
				tickets.filter((ticket) => !ticket.archivedAt && ticket.epicId === epic.id),
			),
		);
	}
	async get(actor: Actor, id: string): Promise<EpicDetail> {
		this.access.assertOwner(actor);
		if (!epicIdSchema.safeParse(id).success) throw new EpicError("invalid-request");
		const epic = await this.store.get(id);
		if (!epic) throw new EpicError("epic-not-found");
		const children = (await this.tickets.list()).filter((ticket) => !ticket.archivedAt && ticket.epicId === id);
		return { ...summarize(epic, children), children };
	}
	async create(actor: Actor, input: EditEpic): Promise<EpicDetail> {
		this.access.assertOwner(actor);
		const parsed = editEpicSchema.safeParse(input);
		if (!parsed.success) throw new EpicError("invalid-request");
		const epic = await this.store.insert(parsed.data, this.now().toISOString());
		return this.get(actor, epic.id);
	}
	async update(actor: Actor, id: string, input: EditEpic): Promise<EpicDetail> {
		this.access.assertOwner(actor);
		const parsed = editEpicSchema.safeParse(input);
		if (!parsed.success) throw new EpicError("invalid-request");
		await this.get(actor, id);
		await this.store.update(id, parsed.data);
		return this.get(actor, id);
	}
}
