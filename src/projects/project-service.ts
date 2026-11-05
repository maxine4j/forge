import { createLogger } from "@forge/backend-infrastructure/logger";
import {
	createProjectSchema,
	projectIdSchema,
	projectSchema,
	type CreateProject,
	type Project,
} from "@forge/contracts";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { IRepositoryClient } from "../repositories/repository-client.ts";
import { InvalidProjectError, ProjectNotFoundError, ProjectUnavailableError } from "./errors.ts";
import type { IProjectStore } from "./project-store.ts";
import type { ProjectRecord } from "./types.ts";

export interface IProjectService {
	/** All user operations require owner authorization. Safe public projects omit source and diagnostics. */
	create(actor: Actor, input: CreateProject): Promise<Project>;
	list(actor: Actor): Promise<Project[]>;
	get(actor: Actor, id: string): Promise<Project>;
	retry(actor: Actor, id: string): Promise<Project>;
	/** Before accepting traffic, reconcile creating intent and verify ready repository ownership. */
	recover(): Promise<void>;
}
export class ProjectService implements IProjectService {
	private readonly log = createLogger(ProjectService.name);
	private tail: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly store: IProjectStore,
		private readonly repositories: IRepositoryClient,
		private readonly access: IAccessService,
		private readonly generateId: () => string,
		private readonly now: () => Date,
	) {}
	async create(actor: Actor, input: CreateProject): Promise<Project> {
		this.access.assertOwner(actor);
		const result = createProjectSchema.safeParse(input);
		if (!result.success) throw new InvalidProjectError();
		return this.serialize(async () => {
			const record = {
				...result.data,
				id: projectIdSchema.parse(this.generateId()),
				createdAt: this.now().toISOString(),
				status: "creating" as const,
			};
			await this.store.insert(record);
			return this.prepare(record);
		});
	}
	async list(actor: Actor): Promise<Project[]> {
		this.access.assertOwner(actor);
		return (await this.store.list()).map((record) => this.publicProject(record));
	}
	async get(actor: Actor, id: string): Promise<Project> {
		this.access.assertOwner(actor);
		return this.publicProject(await this.requireProject(id));
	}
	async retry(actor: Actor, id: string): Promise<Project> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const record = await this.requireProject(id);
			if (record.status === "ready") return this.publicProject(record);
			await this.store.setStatus(id, "creating");
			return this.prepare(record);
		});
	}
	async recover(): Promise<void> {
		await this.serialize(async () => {
			for (const record of await this.store.list()) {
				if (record.status === "failed") continue;
				if (record.status === "creating") {
					try {
						await this.prepare(record);
					} catch (error) {
						if (!(error instanceof ProjectUnavailableError)) throw error;
					}
				} else {
					try {
						await this.repositories.verify(record.id);
					} catch (err) {
						this.log.error(
							{ err, projectId: record.id },
							"Repository verification failed; preserving data",
						);
						await this.store.setStatus(record.id, "failed");
					}
				}
			}
		});
	}
	private async prepare(record: ProjectRecord): Promise<Project> {
		try {
			await this.repositories.prepare(record.id, record.source);
		} catch (cause) {
			this.log.error(
				{ err: cause, projectId: record.id },
				"Repository preparation failed; preserving intent and data",
			);
			await this.store.setStatus(record.id, "failed");
			throw new ProjectUnavailableError({ cause });
		}
		await this.store.setStatus(record.id, "ready");
		return this.publicProject({ ...record, status: "ready" });
	}
	private async requireProject(id: string): Promise<ProjectRecord> {
		if (!projectIdSchema.safeParse(id).success) throw new InvalidProjectError();
		const record = await this.store.get(id);
		if (!record) throw new ProjectNotFoundError();
		return record;
	}
	private publicProject({ id, name, status, createdAt }: ProjectRecord): Project {
		return projectSchema.parse({ id, name, status, createdAt });
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.tail.then(operation);
		this.tail = next.catch(() => {});
		return next;
	}
}
