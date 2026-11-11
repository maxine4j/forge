import { projectIdSchema, type GithubSyncStatus } from "@forge/contracts";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import { InvalidProjectError, ProjectNotFoundError, ProjectUnavailableError } from "../projects/errors.ts";
import type { ProjectRecord } from "../projects/types.ts";
import type { IGithubSyncClient } from "./github-sync-client.ts";
import type { GithubSyncResult } from "./types.ts";

interface ISyncProjects {
	get(id: string): Promise<ProjectRecord | undefined>;
}

export interface IGithubSyncService {
	status(actor: Actor, id: string): Promise<GithubSyncStatus>;
	sync(actor: Actor, id: string): Promise<GithubSyncResult | { outcome: "unconfigured" | "unavailable" | "busy" }>;
}

export class GithubSyncService implements IGithubSyncService {
	private readonly reads = new Map<string, Promise<GithubSyncStatus>>();
	private syncing = false;

	constructor(
		private readonly client: IGithubSyncClient,
		private readonly projects: ISyncProjects,
		private readonly access: IAccessService,
	) {}
	async status(actor: Actor, id: string): Promise<GithubSyncStatus> {
		if (!(await this.eligible(actor, id))) return { state: "unconfigured" };
		const pending = this.reads.get(id);
		if (pending) return pending;
		const read = this.client
			.status(id)
			.then((counts): GithubSyncStatus => ({ state: "ready", ...counts }))
			.catch((): GithubSyncStatus => ({ state: "unavailable" }))
			.finally(() => this.reads.delete(id));
		this.reads.set(id, read);
		return read;
	}
	async sync(actor: Actor, id: string): ReturnType<IGithubSyncService["sync"]> {
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
		return /^https:\/\/github\.com(?::443)?\/maxine4j\/forge(?:\.git)?\/?$/iu.test(project.source ?? "");
	}
}
