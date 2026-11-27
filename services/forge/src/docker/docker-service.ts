import { dockerIdSchema, type DockerOperation, type DockerOverview } from "@forge/contracts/docker";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { DockerInspection, IDockerClient } from "./docker-client.ts";
import { DockerError } from "./docker-command.ts";

export interface IDockerService {
	overview(actor: Actor): Promise<DockerOverview>;
	operation(actor: Actor, id: string): DockerOperation;
	cleanup(actor: Actor, target?: string): DockerOperation;
}
export class DockerService implements IDockerService {
	private readonly operations = new Map<string, DockerOperation>();
	private latest: DockerOperation | null = null;
	private readonly targets = new Map<string, DockerInspection>();
	private statistics: { at: string; values: Awaited<ReturnType<IDockerClient["stats"]>> } | undefined;
	constructor(
		private readonly client: IDockerClient,
		private readonly access: IAccessService,
		private readonly id: () => string,
		private readonly now: () => Date,
	) {}
	async overview(actor: Actor): Promise<DockerOverview> {
		this.access.assertOwner(actor);
		try {
			const containers = await this.client.containers();
			let stale = false;
			try {
				this.statistics = { at: this.now().toISOString(), values: await this.client.stats() };
			} catch {
				stale = true;
			}
			return {
				available: true,
				containers: containers
					.filter((item) => item.running)
					.map((item) => ({ ...item.summary, stats: this.statistics?.values.get(item.id) ?? null })),
				statisticsAt: this.statistics?.at ?? null,
				statisticsStale: stale,
				operation: this.latest,
			};
		} catch {
			return {
				available: false,
				containers: [],
				statisticsAt: this.statistics?.at ?? null,
				statisticsStale: true,
				operation: this.latest,
			};
		}
	}
	operation(actor: Actor, id: string): DockerOperation {
		this.access.assertOwner(actor);
		const result = this.operations.get(id);
		if (!result) throw new DockerError("docker-operation-not-found");
		return structuredClone(result);
	}
	cleanup(actor: Actor, target = "all"): DockerOperation {
		this.access.assertOwner(actor);
		if (target !== "all" && !dockerIdSchema.safeParse(target).success) throw new DockerError("invalid-request");
		if (this.latest?.status === "running") throw new DockerError("docker-busy");
		const operation: DockerOperation = {
			id: this.id(),
			target,
			status: "running",
			progress: "Inspecting Docker resources",
			failures: [],
			retained: [],
			remaining: null,
		};
		this.latest = operation;
		this.operations.set(operation.id, operation);
		// Bound memory while retaining the current and recent operations. No browser owns this work.
		if (this.operations.size > 100) this.operations.delete(this.operations.keys().next().value!);
		void this.execute(operation);
		return structuredClone(operation);
	}
	private async execute(operation: DockerOperation): Promise<void> {
		const attempt = async (description: string, work: () => Promise<void>) => {
			operation.progress = description;
			try {
				await work();
			} catch {
				operation.failures.push(description);
			}
		};
		try {
			if (operation.target === "all") {
				for (const item of await this.client.containers())
					await attempt(`Remove container ${item.id}`, () => this.client.remove("container", item.id));
				await attempt("Prune unused images, networks and build cache", () => this.client.prune());
				await attempt("Prune unused named and anonymous volumes", () => this.client.pruneVolumes());
			} else {
				const target = (await this.client.inspect(operation.target)) ?? this.targets.get(operation.target);
				if (target) {
					this.targets.set(target.id, target);
					if (this.targets.size > 100) this.targets.delete(this.targets.keys().next().value!);
					await attempt(`Remove container ${target.id}`, () => this.client.remove("container", target.id));
					// Include stopped containers. Docker also rejects in-use removal if a workload appears after this read.
					const others = await this.client.containers();
					for (const [kind, names] of [
						["volume", target.volumes],
						["network", target.networks],
					] as const) {
						for (const name of names) {
							if (
								others.some((item) => (kind === "volume" ? item.volumes : item.networks).includes(name))
							)
								operation.retained.push(`${kind}: ${name} (shared)`);
							else await attempt(`Remove ${kind} ${name}`, () => this.client.remove(kind, name));
						}
					}
					if (others.some((item) => item.image === target.image))
						operation.retained.push(`image: ${target.image} (shared)`);
					else {
						for (const tag of await this.client.imageTags(target.image))
							await attempt(`Remove image tag ${tag}`, () => this.client.remove("image", tag));
						await attempt(`Remove image ${target.image}`, () => this.client.remove("image", target.image));
					}
				}
			}
		} catch {
			operation.failures.push("Read Docker resources");
		}
		await attempt("Recheck remaining Docker resources", async () => {
			operation.remaining = await this.client.resources();
		});
		operation.status = operation.failures.length ? "partial" : "completed";
		if (operation.status === "completed") {
			if (operation.target === "all") this.targets.clear();
			else this.targets.delete(operation.target);
		}
		operation.progress = "Cleanup finished; agents may create new workloads at any time.";
	}
}
