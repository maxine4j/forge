import { projectSchema, remoteSourceSchema } from "@forge/contracts";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";
import { ProjectStorageError } from "./errors.ts";
import type { ProjectRecord } from "./types.ts";

const recordSchema = projectSchema.extend({ source: remoteSourceSchema.nullable() });
export interface IProjectStore {
	/** Inserts durable intent; duplicate IDs and persistence failures throw ProjectStorageError. */
	insert(record: ProjectRecord): Promise<void>;
	get(id: string): Promise<ProjectRecord | undefined>;
	/** Ordered by creation then ID. Maximum 1000 projects in slice 1. */
	list(): Promise<ProjectRecord[]>;
	setStatus(id: string, status: ProjectRecord["status"]): Promise<void>;
}
export class ProjectStore implements IProjectStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		try {
			await this.database.run(
				"CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('creating','ready','failed')), createdAt TEXT NOT NULL, source TEXT)",
			);
		} catch (cause) {
			throw new ProjectStorageError({ cause });
		}
	}
	async insert(record: ProjectRecord): Promise<void> {
		try {
			this.decode({ ...record, source: record.source ?? null });
			const inserted = await this.database.run(
				"INSERT INTO projects (id, name, status, createdAt, source) SELECT ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM projects) < 1000",
				[record.id, record.name, record.status, record.createdAt, record.source ?? null],
			);
			if (inserted !== 1) throw new Error("Project capacity reached");
		} catch (cause) {
			throw new ProjectStorageError({ cause });
		}
	}
	async get(id: string): Promise<ProjectRecord | undefined> {
		try {
			const rows = await this.database.all(
				"SELECT id, name, status, createdAt, source FROM projects WHERE id = ?",
				[id],
			);
			return rows.length ? this.decode(rows.at(0)) : undefined;
		} catch (cause) {
			throw new ProjectStorageError({ cause });
		}
	}
	async list(): Promise<ProjectRecord[]> {
		try {
			return (
				await this.database.all(
					"SELECT id, name, status, createdAt, source FROM projects ORDER BY createdAt, id",
				)
			).map((row) => this.decode(row));
		} catch (cause) {
			throw new ProjectStorageError({ cause });
		}
	}
	async setStatus(id: string, status: ProjectRecord["status"]): Promise<void> {
		try {
			z.enum(["creating", "ready", "failed"]).parse(status);
			if ((await this.database.run("UPDATE projects SET status = ? WHERE id = ?", [status, id])) !== 1)
				throw new Error("Project intent missing");
		} catch (cause) {
			throw new ProjectStorageError({ cause });
		}
	}
	private decode(value: unknown): ProjectRecord {
		const { source, ...project } = recordSchema.parse(value);
		return source === null ? project : { ...project, source };
	}
}
