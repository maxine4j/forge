import { type AgentOptions } from "@forge/contracts/agents";
import {
	modelProviderInputSchema,
	modelProviderPatchSchema,
	type ModelProvider,
	type ModelProviderHealth,
} from "@forge/contracts/model-providers";
import type { InferenceProvider } from "@forge/contracts/settings";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import { modelRates } from "../cost/api-pricing.ts";
import { ModelProviderError } from "./errors.ts";
import type { IModelProviderStore } from "./model-provider-store.ts";

export interface IModelProviderService {
	health(actor: Actor): Promise<ModelProviderHealth[]>;
	list(actor: Actor): Promise<ModelProvider[]>;
	create(actor: Actor, input: unknown): Promise<ModelProvider>;
	update(actor: Actor, id: string, input: unknown): Promise<ModelProvider>;
	remove(actor: Actor, id: string): Promise<void>;
	require(actor: Actor, id?: string): Promise<ModelProvider>;
	options(actor: Actor, id: string): Promise<AgentOptions>;
	snapshotOptions(actor: Actor, configuration: InferenceProvider): Promise<AgentOptions>;
}
export function inferenceConfiguration(provider: ModelProvider, model?: string): InferenceProvider {
	const threshold =
		provider.compactionThresholdTokens === undefined
			? {}
			: { compactionThresholdTokens: provider.compactionThresholdTokens };
	if (provider.kind === "openai") return { kind: "openai", ...threshold };
	if (!model || !provider.endpoint) throw new ModelProviderError("invalid-provider");
	return { kind: "ollama", endpoint: provider.endpoint, model, ...threshold };
}
export class ModelProviderService implements IModelProviderService {
	constructor(
		private readonly store: IModelProviderStore,
		private readonly access: IAccessService,
		private readonly id: () => string,
		private readonly catalog: (provider: InferenceProvider) => Promise<AgentOptions>,
		private readonly serialize: <T>(operation: () => Promise<T>) => Promise<T> = (operation) => operation(),
		private readonly wake: () => void = () => {},
		private readonly checkHealth: (provider: ModelProvider) => Promise<ModelProviderHealth["status"]> = async () =>
			"unhealthy",
	) {}
	async health(actor: Actor): Promise<ModelProviderHealth[]> {
		this.access.assertOwner(actor);
		const providers = await this.store.list();
		return Promise.all(
			providers
				.filter((provider) => !provider.retired)
				.map(async (provider) => {
					let status: ModelProviderHealth["status"] = "unhealthy";
					try {
						status = await this.checkHealth(provider);
					} catch {
						/* Keep other results available. */
					}
					return { providerId: provider.id, status };
				}),
		);
	}
	async list(actor: Actor): Promise<ModelProvider[]> {
		this.access.assertOwner(actor);
		return this.store.list();
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
		if (provider.kind === "ollama") throw new ModelProviderError("invalid-provider");
		return this.snapshotOptions(actor, inferenceConfiguration(provider));
	}
	async snapshotOptions(actor: Actor, configuration: InferenceProvider): Promise<AgentOptions> {
		this.access.assertOwner(actor);
		return this.catalog(configuration);
	}
	async create(actor: Actor, input: unknown): Promise<ModelProvider> {
		this.access.assertOwner(actor);
		return this.serialize(() => this.save(this.id(), input));
	}
	async update(actor: Actor, id: string, input: unknown): Promise<ModelProvider> {
		return this.serialize(async () => {
			const previous = await this.require(actor, id);
			const patch = modelProviderPatchSchema.safeParse(input);
			if (!patch.success) throw new ModelProviderError("invalid-provider");
			const merged = { ...previous, ...patch.data };
			if (merged.comparisonModel === null) merged.comparisonModel = undefined;
			if (merged.compactionThresholdTokens === null) merged.compactionThresholdTokens = undefined;
			if (merged.kind !== previous.kind) throw new ModelProviderError("invalid-provider");
			const { id: _id, retired: _retired, contextWindow, supportedConcurrency, ...configuration } = merged;
			const value = await this.save(id, configuration, { contextWindow, supportedConcurrency });
			this.wake();
			return value;
		});
	}
	async remove(actor: Actor, id: string): Promise<void> {
		await this.serialize(async () => {
			const value = await this.require(actor, id);
			await this.store.save({ ...value, retired: true });
			this.wake();
		});
	}
	async reconcileRelay(
		origin: string,
		inventory: { workerId: string; contextWindow: number | null; concurrency: number | null }[],
		conflict: (workerId: string) => void,
	): Promise<void> {
		await this.serialize(async () => {
			const active = await this.store.list();
			for (const worker of inventory) {
				const endpoint = `${origin}/${worker.workerId}/openai/v1`;
				const existing = active.find(
					(provider) => provider.name.toLowerCase() === worker.workerId.toLowerCase(),
				);
				if (
					existing
					&& (existing.kind !== "ollama"
						|| !existing.endpoint
						|| URL.parse(existing.endpoint)?.href !== new URL(endpoint).href)
				) {
					conflict(worker.workerId);
					continue;
				}
				const value: ModelProvider = existing
					? { ...existing }
					: {
							id: this.id(),
							name: worker.workerId,
							kind: "ollama",
							endpoint,
							retired: false,
							maxConcurrentAgents: 1,
						};
				if (worker.contextWindow !== null) value.contextWindow = worker.contextWindow;
				if (worker.concurrency !== null) value.supportedConcurrency = worker.concurrency;
				if (!existing || JSON.stringify(existing) !== JSON.stringify(value)) {
					await this.store.save(value);
					if (!existing) active.push(value);
					this.wake();
				}
			}
		});
	}
	private async save(
		id: string,
		input: unknown,
		capabilities: Pick<ModelProvider, "contextWindow" | "supportedConcurrency"> = {},
	): Promise<ModelProvider> {
		const parsed = modelProviderInputSchema.safeParse(input);
		if (!parsed.success) throw new ModelProviderError("invalid-provider");
		const value = { ...parsed.data, ...capabilities, id, retired: false };
		if (value.kind === "ollama" && value.comparisonModel && !modelRates(value.comparisonModel))
			throw new ModelProviderError("invalid-provider");
		try {
			await this.store.save(value);
		} catch {
			throw new ModelProviderError("provider-conflict");
		}
		return value;
	}
}
