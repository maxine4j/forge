import { workspaceSchema } from "@forge/contracts";

import type { IDatabase } from "../database/sqlite-database.ts";
import { WorkspaceError } from "./errors.ts";
import type { WorkspaceRecord } from "./types.ts";

export interface IWorkspaceStore {
	/** Durable creation intent. At most 1000 workspaces; archived rows and all Git data remain retained. */
	insert(record: WorkspaceRecord): Promise<void>;
	get(id: string): Promise<WorkspaceRecord | undefined>;
	list(projectId?: string): Promise<WorkspaceRecord[]>;
	update(record: WorkspaceRecord): Promise<void>;
}
export class WorkspaceStore implements IWorkspaceStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.boundary(async () => {
			await this.database.run(
				"CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL, branch TEXT NOT NULL UNIQUE, baseSha TEXT, createdAt TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('creating','ready','failed','archived')))",
			);
		});
	}
	async insert(record: WorkspaceRecord): Promise<void> {
		await this.boundary(async () => {
			workspaceSchema.parse(record);
			const count = await this.database.run(
				"INSERT INTO workspaces (id, projectId, name, branch, baseSha, createdAt, status) SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM workspaces) < 1000",
				[
					record.id,
					record.projectId,
					record.name,
					record.branch,
					record.baseSha ?? null,
					record.createdAt,
					record.status,
				],
			);
			if (count !== 1) throw new Error("Workspace capacity reached");
		});
	}
	async get(id: string): Promise<WorkspaceRecord | undefined> {
		return this.boundary(async () => {
			const row = (await this.database.all("SELECT * FROM workspaces WHERE id = ?", [id])).at(0);
			return row ? this.decode(row) : undefined;
		});
	}
	async list(projectId?: string): Promise<WorkspaceRecord[]> {
		return this.boundary(async () =>
			(
				await this.database.all(
					`SELECT * FROM workspaces${projectId ? " WHERE projectId = ?" : ""} ORDER BY createdAt, id`,
					projectId ? [projectId] : [],
				)
			).map((row) => this.decode(row)),
		);
	}
	async update(record: WorkspaceRecord): Promise<void> {
		await this.boundary(async () => {
			workspaceSchema.parse(record);
			if (
				(await this.database.run(
					"UPDATE workspaces SET name = ?, baseSha = ?, status = ? WHERE id = ? AND projectId = ? AND branch = ?",
					[record.name, record.baseSha ?? null, record.status, record.id, record.projectId, record.branch],
				)) !== 1
			)
				throw new Error("Workspace missing");
		});
	}
	private decode(row: unknown): WorkspaceRecord {
		const result = workspaceSchema.extend({ baseSha: workspaceSchema.shape.baseSha.nullable() }).parse(row);
		return { ...result, baseSha: result.baseSha ?? undefined };
	}
	private async boundary<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			throw new WorkspaceError("workspace-unavailable", { cause });
		}
	}
}
