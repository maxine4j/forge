import {
	boardSettingsUpdateSchema,
	defaultBoardSettings,
	type BoardSettings,
	type BoardSettingsUpdate,
	type BoardStop,
} from "@forge/contracts/tickets";

import type { IAgentStop } from "../agents/agent-service.ts";
import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { IBoardSettingsStore } from "./board-settings-store.ts";
import { TicketError } from "./errors.ts";

export interface IBoardSettingsService {
	get(actor: Actor): BoardSettings;
	update(actor: Actor, input: BoardSettingsUpdate): Promise<BoardSettings>;
	stop(actor: Actor): Promise<BoardStop>;
}

export class BoardSettingsService implements IBoardSettingsService {
	private settings: BoardSettings = { ...defaultBoardSettings };
	private tail: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly store: IBoardSettingsStore,
		private readonly agents: IAgentStop,
		private readonly access: IAccessService,
		private readonly wake: () => void,
	) {}
	async initialize(): Promise<void> {
		this.settings = await this.store.load();
	}
	maxConcurrentTickets(): number {
		return this.settings.maxAgents;
	}
	dispatchMode(): BoardSettings["dispatch"] {
		return this.settings.dispatch;
	}
	get(actor: Actor): BoardSettings {
		this.access.assertOwner(actor);
		return { ...this.settings };
	}
	async update(actor: Actor, input: BoardSettingsUpdate): Promise<BoardSettings> {
		this.access.assertOwner(actor);
		const parsed = boardSettingsUpdateSchema.safeParse(input);
		if (!parsed.success) throw new TicketError("invalid-request");
		return this.serialize(async () => {
			const settings = {
				dispatch: parsed.data.dispatch ?? this.settings.dispatch,
				maxAgents: parsed.data.maxAgents ?? this.settings.maxAgents,
			};
			await this.apply(settings);
			return { ...settings };
		});
	}
	async stop(actor: Actor): Promise<BoardStop> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const settings = { ...this.settings, dispatch: "stopped" } as const;
			await this.apply(settings);
			return { settings, ...(await this.agents.stopAll(actor)) };
		});
	}
	private async apply(settings: BoardSettings): Promise<void> {
		const previous = this.settings;
		await this.store.save(settings);
		this.settings = settings;
		if (
			settings.maxAgents > previous.maxAgents
			|| (previous.dispatch !== settings.dispatch && settings.dispatch !== "stopped")
		)
			this.wake();
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.catch(() => {});
		return result;
	}
}
