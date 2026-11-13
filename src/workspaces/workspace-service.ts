import { createLogger } from "@forge/backend-infrastructure/logger";
import {
	createWorkspaceSchema,
	createWorkspaceFileSchema,
	saveWorkspaceFileSchema,
	workspaceIdSchema,
	workspacePathsSchema,
	workspaceCommitSchema,
	type Workspace,
	type CreateWorkspace,
	type WorkspaceFile,
	type CreateWorkspaceFile,
	type SaveWorkspaceFile,
	type WorkspaceTree,
	type WorkspacePaths,
	type WorkspaceCommit,
	type WorkspaceDiff,
} from "@forge/contracts";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { IProjectService } from "../projects/project-service.ts";
import { WorkspaceError } from "./errors.ts";
import type { WorkspaceLocation, WorkspaceRecord } from "./types.ts";
import type { IWorkspaceClient } from "./workspace-client.ts";
import type { IWorkspaceDiffClient } from "./workspace-diff-client.ts";
import type { IWorkspaceStore } from "./workspace-store.ts";

export interface IWorkspaceService {
	/** Owner authorization is rechecked for every public operation. All API writes are serialized. */
	create(
		actor: Actor,
		projectId: string,
		input: CreateWorkspace,
		allocated?: (workspaceId: string) => Promise<void>,
	): Promise<Workspace>;
	list(actor: Actor, projectId: string): Promise<Workspace[]>;
	get(actor: Actor, id: string): Promise<Workspace>;
	rename(actor: Actor, id: string, input: CreateWorkspace): Promise<Workspace>;
	/** Archives only. Working files, commits, branch and durable identity are retained. */
	archive(actor: Actor, id: string): Promise<Workspace>;
	retry(actor: Actor, id: string): Promise<Workspace>;
	resolve(actor: Actor, id: string): Promise<WorkspaceLocation>;
	tree(actor: Actor, id: string, path: string): Promise<WorkspaceTree>;
	readFile(actor: Actor, id: string, path: string): Promise<WorkspaceFile>;
	createFile(actor: Actor, id: string, input: CreateWorkspaceFile): Promise<WorkspaceFile>;
	saveFile(actor: Actor, id: string, input: SaveWorkspaceFile): Promise<WorkspaceFile>;
	diff(actor: Actor, id: string): Promise<WorkspaceDiff>;
	stage(actor: Actor, id: string, input: WorkspacePaths): Promise<Workspace>;
	unstage(actor: Actor, id: string, input: WorkspacePaths): Promise<Workspace>;
	commit(actor: Actor, id: string, input: WorkspaceCommit): Promise<Workspace>;
	/** Call before accepting requests; failed records need explicit retry. */
	recover(): Promise<void>;
}
export interface IMergedWorkspaceCleanup {
	/** Removes a verified merged worktree and branch, retaining archived workspace metadata. Safe to retry. */
	cleanupMerged(actor: Actor, id: string, candidate: string): Promise<void>;
}
export interface IAbandonedWorkspaceCleanup {
	/** Closes terminals and discards owned unmerged work, preserving archived metadata. */
	cleanupAbandoned(actor: Actor, id: string): Promise<void>;
}
export class WorkspaceService implements IWorkspaceService, IMergedWorkspaceCleanup, IAbandonedWorkspaceCleanup {
	private readonly log = createLogger(WorkspaceService.name);
	private tail: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly store: IWorkspaceStore,
		private readonly client: IWorkspaceClient,
		private readonly projects: IProjectService,
		private readonly access: IAccessService,
		private readonly generateId: () => string,
		private readonly now: () => Date,
		private readonly differences: IWorkspaceDiffClient,
	) {}
	async create(
		actor: Actor,
		projectId: string,
		input: CreateWorkspace,
		allocated?: (workspaceId: string) => Promise<void>,
	): Promise<Workspace> {
		this.access.assertOwner(actor);
		const data = createWorkspaceSchema.safeParse(input);
		if (!data.success) throw new WorkspaceError("invalid-request");
		if ((await this.projects.get(actor, projectId)).status !== "ready")
			throw new WorkspaceError("workspace-unavailable");
		return this.serialize(async () => {
			const id = workspaceIdSchema.parse(this.generateId());
			const record: WorkspaceRecord = {
				id,
				projectId,
				name: data.data.name,
				branch: `forge/workspace/${id}`,
				createdAt: this.now().toISOString(),
				status: "creating",
			};
			// Persist the caller's ownership reference before metadata or filesystem allocation.
			await allocated?.(id);
			await this.store.insert(record);
			return this.prepare(record);
		});
	}
	async list(actor: Actor, projectId: string): Promise<Workspace[]> {
		this.access.assertOwner(actor);
		await this.projects.get(actor, projectId);
		return this.serialize(async () =>
			Promise.all((await this.store.list(projectId)).map((record) => this.publicWorkspace(record))),
		);
	}
	async get(actor: Actor, id: string): Promise<Workspace> {
		this.access.assertOwner(actor);
		return this.serialize(async () => this.publicWorkspace(await this.require(id)));
	}
	async rename(actor: Actor, id: string, input: CreateWorkspace): Promise<Workspace> {
		this.access.assertOwner(actor);
		const data = createWorkspaceSchema.safeParse(input);
		if (!data.success) throw new WorkspaceError("invalid-request");
		return this.serialize(async () => {
			const record = { ...(await this.require(id)), name: data.data.name };
			await this.store.update(record);
			return this.publicWorkspace(record);
		});
	}
	async archive(actor: Actor, id: string): Promise<Workspace> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const record = { ...(await this.require(id)), status: "archived" as const };
			await this.store.update(record);
			return record;
		});
	}
	async cleanupMerged(actor: Actor, id: string, candidate: string): Promise<void> {
		this.access.assertOwner(actor);
		await this.serialize(async () => {
			const record = await this.require(id);
			await this.client.removeMerged(record, candidate);
			if (record.status !== "archived") await this.store.update({ ...record, status: "archived" });
		});
	}
	async cleanupAbandoned(actor: Actor, id: string): Promise<void> {
		this.access.assertOwner(actor);
		await this.serialize(async () => {
			if (!workspaceIdSchema.safeParse(id).success) throw new WorkspaceError("invalid-request");
			const record = await this.store.get(id);
			// Allocation intent can precede workspace metadata and every filesystem side effect.
			if (!record) return;
			await this.client.removeAbandoned(record);
			if (record.status !== "archived") await this.store.update({ ...record, status: "archived" });
		});
	}
	async retry(actor: Actor, id: string): Promise<Workspace> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const record = await this.require(id);
			if (record.status === "archived") throw new WorkspaceError("workspace-unavailable");
			if (record.status === "ready") return this.publicWorkspace(record);
			const intent = { ...record, status: "creating" as const };
			await this.store.update(intent);
			return this.prepare(intent);
		});
	}
	async resolve(actor: Actor, id: string): Promise<WorkspaceLocation> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const record = await this.ready(id);
			return { workspace: await this.publicWorkspace(record), path: await this.client.location(record) };
		});
	}
	async tree(actor: Actor, id: string, path: string): Promise<WorkspaceTree> {
		this.access.assertOwner(actor);
		return this.serialize(async () => this.client.tree(await this.ready(id), path));
	}
	async readFile(actor: Actor, id: string, path: string): Promise<WorkspaceFile> {
		this.access.assertOwner(actor);
		return this.serialize(async () => this.client.read(await this.ready(id), path));
	}
	async createFile(actor: Actor, id: string, input: CreateWorkspaceFile): Promise<WorkspaceFile> {
		this.access.assertOwner(actor);
		const data = createWorkspaceFileSchema.safeParse(input);
		if (!data.success) throw new WorkspaceError("invalid-request");
		return this.serialize(async () => this.client.createFile(await this.ready(id), data.data));
	}
	async saveFile(actor: Actor, id: string, input: SaveWorkspaceFile): Promise<WorkspaceFile> {
		this.access.assertOwner(actor);
		const data = saveWorkspaceFileSchema.safeParse(input);
		if (!data.success) throw new WorkspaceError("invalid-request");
		return this.serialize(async () => this.client.saveFile(await this.ready(id), data.data));
	}
	async diff(actor: Actor, id: string): Promise<WorkspaceDiff> {
		this.access.assertOwner(actor);
		return this.serialize(async () => this.differences.diff(await this.ready(id)));
	}
	async stage(actor: Actor, id: string, input: WorkspacePaths): Promise<Workspace> {
		return this.changeIndex(actor, id, input, false);
	}
	async unstage(actor: Actor, id: string, input: WorkspacePaths): Promise<Workspace> {
		return this.changeIndex(actor, id, input, true);
	}
	async commit(actor: Actor, id: string, input: WorkspaceCommit): Promise<Workspace> {
		this.access.assertOwner(actor);
		const data = workspaceCommitSchema.safeParse(input);
		if (!data.success) throw new WorkspaceError("invalid-request");
		return this.serialize(async () => {
			const record = await this.ready(id);
			await this.client.commit(record, data.data.message, data.data.expectedHead);
			return this.publicWorkspace(record);
		});
	}
	async recover(): Promise<void> {
		await this.serialize(async () => {
			for (const record of await this.store.list()) {
				if (record.status === "archived" || record.status === "failed") continue;
				try {
					if (record.status === "creating") await this.prepare(record);
					else await this.client.verify(record);
				} catch (err) {
					this.log.error({ err, workspaceId: record.id }, "Workspace recovery failed; preserving data");
					await this.store.update({ ...record, status: "failed" });
				}
			}
		});
	}
	private async changeIndex(actor: Actor, id: string, input: WorkspacePaths, unstage: boolean): Promise<Workspace> {
		this.access.assertOwner(actor);
		const data = workspacePathsSchema.safeParse(input);
		if (!data.success) throw new WorkspaceError("invalid-request");
		return this.serialize(async () => {
			const record = await this.ready(id);
			await this.client.stage(record, data.data.paths, unstage);
			return this.publicWorkspace(record);
		});
	}
	private async require(id: string): Promise<WorkspaceRecord> {
		if (!workspaceIdSchema.safeParse(id).success) throw new WorkspaceError("invalid-request");
		const record = await this.store.get(id);
		if (!record) throw new WorkspaceError("workspace-not-found");
		return record;
	}
	private async ready(id: string): Promise<WorkspaceRecord> {
		const record = await this.require(id);
		if (record.status !== "ready") throw new WorkspaceError("workspace-unavailable");
		return record;
	}
	private async publicWorkspace(record: WorkspaceRecord): Promise<Workspace> {
		return record.status === "ready" ? { ...record, head: await this.client.head(record) } : record;
	}
	private async prepare(record: WorkspaceRecord): Promise<Workspace> {
		try {
			const baseSha = await this.client.prepare(record);
			const ready = { ...record, baseSha: record.baseSha ?? baseSha, status: "ready" as const };
			await this.store.update(ready);
			return this.publicWorkspace(ready);
		} catch (cause) {
			this.log.error(
				{ err: cause, workspaceId: record.id },
				"Workspace preparation failed; preserving intent and data",
			);
			await this.store.update({ ...record, status: "failed" });
			throw new WorkspaceError("workspace-unavailable", { cause });
		}
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.tail.then(operation);
		this.tail = next.catch(() => {});
		return next;
	}
}
