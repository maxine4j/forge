import { projectIdSchema, type UpstreamSyncStatus } from "@forge/contracts";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import { InvalidProjectError, ProjectNotFoundError, ProjectUnavailableError } from "../projects/errors.ts";
import type { ProjectRecord } from "../projects/types.ts";
import type { IRepositoryClient } from "./repository-client.ts";
import type { UpstreamSyncResult } from "./types.ts";
import type { IUpstreamSyncClient } from "./upstream-sync-client.ts";

interface ISyncProjects {
	get(id: string): Promise<ProjectRecord | undefined>;
}

export interface IUpstreamSyncService {
	status(actor: Actor, id: string): Promise<UpstreamSyncStatus>;
	sync(actor: Actor, id: string): Promise<UpstreamSyncResult | { outcome: "unconfigured" | "unavailable" | "busy" }>;
}

export class UpstreamSyncService implements IUpstreamSyncService {
	private readonly reads = new Map<string, Promise<UpstreamSyncStatus>>();
	private syncing = false;

	constructor(
		private readonly client: IUpstreamSyncClient,
		private readonly projects: ISyncProjects,
		private readonly access: IAccessService,
		private readonly repositories: Pick<IRepositoryClient, "hasUpstream">,
	) {}
	async status(actor: Actor, id: string): Promise<UpstreamSyncStatus> {
		if (!(await this.eligible(actor, id))) return { state: "unconfigured" };
		const pending = this.reads.get(id);
		if (pending) return pending;
		const read = this.client
			.status(id)
			.then((counts): UpstreamSyncStatus => ({ state: "ready", ...counts }))
			.catch((): UpstreamSyncStatus => ({ state: "unavailable" }))
			.finally(() => this.reads.delete(id));
		this.reads.set(id, read);
		return read;
	}
	async sync(actor: Actor, id: string): ReturnType<IUpstreamSyncService["sync"]> {
		if (!(await this.eligible(actor, id))) return { outcome: "unconfigured" };
		if (this.syncing) return { outcome: "busy" };
		this.syncing = true;
		try {
			return await this.client.sync(id);
		} catch {
			return { outcome: "unavailable" };
		} finally {
			this.syncing = false;
		}
	}
	private async eligible(actor: Actor, id: string): Promise<boolean> {
		this.access.assertOwner(actor);
		if (!projectIdSchema.safeParse(id).success) throw new InvalidProjectError();
		const project = await this.projects.get(id);
		if (!project) throw new ProjectNotFoundError();
		if (project.status !== "ready") throw new ProjectUnavailableError();
		return this.repositories.hasUpstream(id);
	}
}
