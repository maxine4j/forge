import { resolveAgentSettings, type AgentOptions } from "@forge/contracts/agents";
import {
	modelProviderInputSchema,
	modelProviderPatchSchema,
	type ModelProvider,
} from "@forge/contracts/model-providers";
import type { InferenceProvider } from "@forge/contracts/settings";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import { ModelProviderError } from "./errors.ts";
import type { IModelProviderStore } from "./model-provider-store.ts";

export interface IModelProviderService {
	list(actor: Actor): Promise<ModelProvider[]>;
	create(actor: Actor, input: unknown): Promise<ModelProvider>;
	update(actor: Actor, id: string, input: unknown): Promise<ModelProvider>;
	remove(actor: Actor, id: string): Promise<void>;
	require(actor: Actor, id?: string): Promise<ModelProvider>;
	options(actor: Actor, id: string): Promise<AgentOptions>;
	snapshotOptions(actor: Actor, configuration: InferenceProvider, id?: string): Promise<AgentOptions>;
	defaults(actor: Actor, id?: string): Promise<Pick<AgentOptions, "defaultModel" | "defaultReasoningEffort">>;
}
export function inferenceConfiguration(provider: ModelProvider): InferenceProvider {
	return provider.kind === "ollama"
		? { kind: "ollama", endpoint: provider.endpoint!, model: provider.model! }
		: { kind: "openai" };
}
export class ModelProviderService implements IModelProviderService {
	constructor(
		private readonly store: IModelProviderStore,
		private readonly access: IAccessService,
		private readonly id: () => string,
		private readonly catalog: (provider: InferenceProvider) => Promise<AgentOptions>,
	) {}
	async list(actor: Actor): Promise<ModelProvider[]> {
		this.access.assertOwner(actor);
		return this.store.list();
	}
	async defaults(actor: Actor, id?: string): Promise<Pick<AgentOptions, "defaultModel" | "defaultReasoningEffort">> {
		this.access.assertOwner(actor);
		const provider = id ? await this.store.get(id) : (await this.store.list(true)).find((p) => p.kind === "openai");
		return {
			defaultModel: provider?.defaultAgentModel,
			defaultReasoningEffort: provider?.defaultAgentReasoningEffort,
		};
	}
	async require(actor: Actor, id?: string): Promise<ModelProvider> {
		this.access.assertOwner(actor);
		if (!id) throw new ModelProviderError("provider-required");
		const provider = await this.store.get(id);
		if (!provider) throw new ModelProviderError("provider-not-found");
		if (provider.retired) throw new ModelProviderError("provider-retired");
		return provider;
	}
	async options(actor: Actor, id: string): Promise<AgentOptions> {
		const provider = await this.require(actor, id);
		return this.snapshotOptions(actor, inferenceConfiguration(provider), provider.id);
	}
	async snapshotOptions(actor: Actor, configuration: InferenceProvider, id?: string): Promise<AgentOptions> {
		this.access.assertOwner(actor);
		const options = await this.catalog(configuration);
		return configuration.kind === "openai" ? { ...options, ...(await this.defaults(actor, id)) } : options;
	}
	async create(actor: Actor, input: unknown): Promise<ModelProvider> {
		this.access.assertOwner(actor);
		return this.save(this.id(), input);
	}
	async update(actor: Actor, id: string, input: unknown): Promise<ModelProvider> {
		const previous = await this.require(actor, id);
		const patch = modelProviderPatchSchema.safeParse(input);
		if (!patch.success) throw new ModelProviderError("invalid-provider");
		const merged = { ...previous, ...patch.data };
		if (merged.defaultAgentModel === null) merged.defaultAgentModel = undefined;
		if (merged.defaultAgentReasoningEffort === null) merged.defaultAgentReasoningEffort = undefined;
		if (merged.kind !== previous.kind) throw new ModelProviderError("invalid-provider");
		const { id: _id, retired: _retired, ...configuration } = merged;
		return this.save(id, configuration, previous);
	}
	async remove(actor: Actor, id: string): Promise<void> {
		const value = await this.require(actor, id);
		await this.store.save({ ...value, retired: true });
	}
	private async save(id: string, input: unknown, previous?: ModelProvider): Promise<ModelProvider> {
		const parsed = modelProviderInputSchema.safeParse(input);
		if (!parsed.success) throw new ModelProviderError("invalid-provider");
		const value = { ...parsed.data, id, retired: false };
		if (
			value.kind === "openai"
			&& (value.defaultAgentModel || value.defaultAgentReasoningEffort)
			&& (value.defaultAgentModel !== previous?.defaultAgentModel
				|| value.defaultAgentReasoningEffort !== previous?.defaultAgentReasoningEffort)
		) {
			const options = await this.catalog({ kind: "openai" });
			if (
				!resolveAgentSettings(options, {
					model: value.defaultAgentModel,
					reasoningEffort: value.defaultAgentReasoningEffort,
				}).supported
			)
				throw new ModelProviderError("invalid-provider");
		}
		try {
			await this.store.save(value);
		} catch {
			throw new ModelProviderError("provider-conflict");
		}
		return value;
	}
}
