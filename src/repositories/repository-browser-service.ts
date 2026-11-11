import type {
	Project,
	RepositoryBranch,
	RepositoryTree,
	RepositoryFile,
	RepositoryHistory,
	RepositoryCommitInput,
} from "@forge/contracts";
import type { CommitDetail, CommitPatch } from "@forge/contracts";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import { ProjectUnavailableError } from "../projects/errors.ts";
import type { IRepositoryBrowserClient } from "./repository-browser-client.ts";

interface IReadableProjects {
	get(actor: Actor, id: string): Promise<Project>;
}
export interface IRepositoryBrowserService {
	commitDetail(actor: Actor, id: string, sha: string): Promise<CommitDetail>;
	commitPatch(actor: Actor, id: string, sha: string, path: string, ignoreWhitespace: boolean): Promise<CommitPatch>;
	commit(actor: Actor, id: string, input: RepositoryCommitInput): Promise<{ head: string }>;
	branches(actor: Actor, id: string): Promise<RepositoryBranch[]>;
	tree(actor: Actor, id: string, branch: string, path: string): Promise<RepositoryTree>;
	file(actor: Actor, id: string, branch: string, path: string): Promise<RepositoryFile>;
	history(actor: Actor, id: string, branch: string, offset: number): Promise<RepositoryHistory>;
}
export class RepositoryBrowserService implements IRepositoryBrowserService {
	async commitDetail(actor: Actor, id: string, sha: string): Promise<CommitDetail> {
		await this.authorize(actor, id);
		return this.client.commitDetail(id, sha);
	}
	async commitPatch(
		actor: Actor,
		id: string,
		sha: string,
		path: string,
		ignoreWhitespace: boolean,
	): Promise<CommitPatch> {
		await this.authorize(actor, id);
		return this.client.commitPatch(id, sha, path, ignoreWhitespace);
	}
	constructor(
		private readonly client: IRepositoryBrowserClient,
		private readonly projects: IReadableProjects,
		private readonly access: IAccessService,
	) {}
	async commit(actor: Actor, id: string, input: RepositoryCommitInput): Promise<{ head: string }> {
		await this.authorize(actor, id);
		return this.client.commit(id, input);
	}
	async branches(actor: Actor, id: string): Promise<RepositoryBranch[]> {
		await this.authorize(actor, id);
		return this.client.branches(id);
	}
	async tree(actor: Actor, id: string, branch: string, path: string): Promise<RepositoryTree> {
		await this.authorize(actor, id);
		return this.client.tree(id, branch, path);
	}
	async file(actor: Actor, id: string, branch: string, path: string): Promise<RepositoryFile> {
		await this.authorize(actor, id);
		return this.client.file(id, branch, path);
	}
	async history(actor: Actor, id: string, branch: string, offset: number): Promise<RepositoryHistory> {
		await this.authorize(actor, id);
		return this.client.history(id, branch, offset, 30);
	}
	private async authorize(actor: Actor, id: string): Promise<void> {
		this.access.assertOwner(actor);
		if ((await this.projects.get(actor, id)).status !== "ready") throw new ProjectUnavailableError();
	}
}
