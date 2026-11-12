import { resolveAgentSettings, type AgentOptions } from "@forge/contracts/agents";
import {
	defaultForgeSettings,
	forgeSettingsSchema,
	type ForgeSettings,
	type GitIdentity,
} from "@forge/contracts/settings";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { IGitSystemConfig } from "./git-system-config.ts";
import type { ISettingsStore } from "./settings-store.ts";

export class SettingsError extends Error {
	constructor(
		readonly code: "invalid-request" | "unsupported-settings" | "settings-unavailable",
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = "SettingsError";
	}
}

export interface ISettingsService {
	get(actor: Actor): ForgeSettings;
	modelOptions(actor: Actor): Promise<AgentOptions>;
	/** Throws SettingsError for invalid input or failed persistence/publication. */
	save(actor: Actor, input: unknown): Promise<ForgeSettings>;
}

export class SettingsService implements ISettingsService {
	private settings: ForgeSettings = { ...defaultForgeSettings };
	private pending: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly store: ISettingsStore,
		private readonly git: IGitSystemConfig | undefined,
		private readonly access: IAccessService,
		private readonly catalog?: () => Promise<AgentOptions>,
	) {}

	async initialize(): Promise<void> {
		const settings = await this.store.load();
		await this.git?.publish(this.identity(settings));
		this.settings = settings;
	}

	current(): ForgeSettings {
		return { ...this.settings };
	}

	gitIdentity(): GitIdentity | undefined {
		return this.identity(this.settings);
	}

	get(actor: Actor): ForgeSettings {
		this.access.assertOwner(actor);
		return this.current();
	}

	async modelOptions(actor: Actor): Promise<AgentOptions> {
		this.access.assertOwner(actor);
		try {
			if (this.catalog) return await this.catalog();
		} catch (cause) {
			throw new SettingsError("settings-unavailable", { cause });
		}
		throw new SettingsError("settings-unavailable");
	}

	async save(actor: Actor, input: unknown): Promise<ForgeSettings> {
		this.access.assertOwner(actor);
		const parsed = forgeSettingsSchema.safeParse(input);
		if (!parsed.success) throw new SettingsError("invalid-request");
		const saved = this.pending.then(async () => {
			const { defaultAgentModel: model, defaultAgentReasoningEffort: reasoningEffort } = parsed.data;
			if (
				(model || reasoningEffort)
				&& (model !== this.settings.defaultAgentModel
					|| reasoningEffort !== this.settings.defaultAgentReasoningEffort)
			) {
				const options = await this.modelOptions(actor);
				if (!resolveAgentSettings(options, { model, reasoningEffort }).supported)
					throw new SettingsError("unsupported-settings");
			}
			return this.apply(parsed.data);
		});
		this.pending = saved.catch(() => {});
		return saved;
	}

	private async apply(settings: ForgeSettings): Promise<ForgeSettings> {
		const previous = this.settings;
		try {
			await this.store.save(settings);
			if (previous.gitName !== settings.gitName || previous.gitEmail !== settings.gitEmail) {
				try {
					await this.git?.publish(this.identity(settings));
				} catch (publicationFailure) {
					await this.store.save(previous).catch((rollbackFailure: unknown) => {
						throw new AggregateError(
							[publicationFailure, rollbackFailure],
							"Forge settings rollback failed",
						);
					});
					throw publicationFailure;
				}
			}
			this.settings = settings;
			return this.current();
		} catch (cause) {
			throw new SettingsError("settings-unavailable", { cause });
		}
	}

	private identity(settings: ForgeSettings): GitIdentity | undefined {
		return settings.gitName ? { name: settings.gitName, email: settings.gitEmail } : undefined;
	}
}
