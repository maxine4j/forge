import { pipelineRunSchema, type PipelineRun } from "@forge/contracts/pipelines";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";

export interface IPipelineStore {
	save(run: PipelineRun): Promise<void>;
	get(id: string): Promise<PipelineRun | undefined>;
	list(projectId: string, offset: number): Promise<PipelineRun[]>;
	unfinished(afterId?: string): Promise<PipelineRun[]>;
	cleaned(id: string): Promise<void>;
}
export class PipelineStore implements IPipelineStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.database.run(
			"CREATE TABLE IF NOT EXISTS pipeline_runs (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), createdAt TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, cleaned INTEGER NOT NULL DEFAULT 0)",
		);
		await this.database.run(
			"CREATE INDEX IF NOT EXISTS pipeline_runs_project ON pipeline_runs(projectId, createdAt DESC)",
		);
	}
	async save(run: PipelineRun): Promise<void> {
		await this.database.run(
			"INSERT INTO pipeline_runs(id, projectId, createdAt, state, data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state, data=excluded.data",
			[run.id, run.projectId, run.createdAt, run.state, JSON.stringify(pipelineRunSchema.parse(run))],
		);
	}
	private async read(sql: string, parameters: (string | number)[] = []): Promise<PipelineRun[]> {
		return (await this.database.all(sql, parameters)).map((row) =>
			pipelineRunSchema.parse(JSON.parse(z.object({ data: z.string() }).parse(row).data)),
		);
	}
	async get(id: string): Promise<PipelineRun | undefined> {
		return (await this.read("SELECT data FROM pipeline_runs WHERE id=?", [id]))[0];
	}
	list(projectId: string, offset: number): Promise<PipelineRun[]> {
		return this.read(
			"SELECT data FROM pipeline_runs WHERE projectId=? ORDER BY createdAt DESC, id DESC LIMIT 21 OFFSET ?",
			[projectId, offset],
		);
	}
	unfinished(afterId = ""): Promise<PipelineRun[]> {
		return this.read(
			"SELECT data FROM pipeline_runs WHERE (state IN ('pending','running') OR cleaned=0) AND id > ? ORDER BY id LIMIT 1000",
			[afterId],
		);
	}
	async cleaned(id: string): Promise<void> {
		await this.database.run("UPDATE pipeline_runs SET cleaned=1 WHERE id=?", [id]);
	}
}
