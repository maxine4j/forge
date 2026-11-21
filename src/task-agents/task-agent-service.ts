import { resolveAgentSettings } from "@forge/contracts/agents";
import { inferenceProviderSchema } from "@forge/contracts/settings";
import { taskAgentInputSchema, type TaskAgent } from "@forge/contracts/task-agents";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import { ModelProviderError } from "../model-providers/errors.ts";
import { inferenceConfiguration, type IModelProviderService } from "../model-providers/model-provider-service.ts";
import type { ModelProviderSnapshot } from "../model-providers/types.ts";
import type { ITaskAgentStore } from "./task-agent-store.ts";

export class TaskAgentError extends Error {
	constructor(
		readonly status: 400 | 404 | 409,
		code: string,
	) {
		super(code);
	}
}

export interface ITaskAgents {
	list(actor: Actor): Promise<TaskAgent[]>;
	save(actor: Actor, input: unknown, id?: string): Promise<TaskAgent>;
	retire(actor: Actor, id: string): Promise<void>;
	resolve(actor: Actor, id?: string): Promise<ModelProviderSnapshot>;
}

export class TaskAgentService implements ITaskAgents {
	constructor(
		private readonly store: ITaskAgentStore,
		private readonly providers: IModelProviderService,
		private readonly access: IAccessService,
		private readonly id: () => string,
	) {}
	list(actor: Actor): Promise<TaskAgent[]> {
		this.access.assertOwner(actor);
		return this.store.list();
	}
	async save(actor: Actor, input: unknown, id?: string): Promise<TaskAgent> {
		this.access.assertOwner(actor);
		if (id !== undefined) await this.active(id);
		const parsed = taskAgentInputSchema.safeParse(input);
		if (!parsed.success) throw new TaskAgentError(400, "invalid-task-agent");
		const settings = parsed.data;
		try {
			const provider = await this.providers.require(actor, settings.providerId);
			const valid =
				provider.kind === "ollama"
					? settings.reasoningEffort === undefined
						&& inferenceProviderSchema.options[1].shape.model.safeParse(settings.model).success
					: resolveAgentSettings(await this.providers.options(actor, provider.id), settings).supported;
			if (!valid) throw new TaskAgentError(400, "invalid-task-agent");
		} catch (error) {
			if (error instanceof ModelProviderError) throw new TaskAgentError(400, "invalid-task-agent");
			throw error;
		}
		const agent = { ...settings, id: id ?? this.id(), retired: false };
		await this.write(agent);
		return agent;
	}
	async retire(actor: Actor, id: string): Promise<void> {
		this.access.assertOwner(actor);
		if (!(await this.store.retire(id))) {
			if (await this.store.get(id)) throw new TaskAgentError(409, "task-agent-retired");
			throw new TaskAgentError(404, "task-agent-not-found");
		}
	}
	async resolve(actor: Actor, id?: string): Promise<ModelProviderSnapshot> {
		this.access.assertOwner(actor);
		const agent = id ? await this.store.get(id) : undefined;
		if (!agent || agent.retired) throw new ModelProviderError("provider-required");
		const provider = await this.providers.require(actor, agent.providerId);
		const configuration = inferenceConfiguration(provider, agent.model);
		const options = await this.providers.snapshotOptions(actor, configuration);
		const resolved = resolveAgentSettings(options, agent);
		if (!resolved.supported) throw new ModelProviderError("invalid-provider");
		return {
			providerId: provider.id,
			providerName: provider.name,
			configuration,
			agentId: agent.id,
			model: resolved.model?.id,
			reasoningEffort: resolved.reasoningEffort,
		};
	}
	private async active(id: string): Promise<TaskAgent> {
		const agent = await this.store.get(id);
		if (!agent) throw new TaskAgentError(404, "task-agent-not-found");
		if (agent.retired) throw new TaskAgentError(409, "task-agent-retired");
		return agent;
	}
	private async write(agent: TaskAgent): Promise<void> {
		try {
			await this.store.save(agent);
		} catch (cause) {
			if (
				(await this.store.get(agent.id).then((value) => value?.retired))
				|| (await this.store.list()).some(
					(value) =>
						!value.retired
						&& value.id !== agent.id
						&& value.name.toLowerCase() === agent.name.toLowerCase(),
				)
			)
				throw new TaskAgentError(409, "task-agent-conflict");
			throw cause;
		}
	}
}
