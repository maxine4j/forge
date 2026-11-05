import { terminalSessionSchema, type TerminalSession } from "@forge/contracts/terminal";

import type { IDatabase } from "../database/sqlite-database.ts";
import { TerminalError } from "./errors.ts";

export interface ITerminalStore {
	/** Validated normalized metadata only; failures throw TerminalError without public diagnostics. */
	insert(session: TerminalSession): Promise<void>;
	update(session: TerminalSession): Promise<void>;
	get(id: string): Promise<TerminalSession | undefined>;
	latest(workspaceId: string): Promise<TerminalSession | undefined>;
	/** Active records become lost; never resumes a shell or stores transcript bytes. */
	loseActive(endedAt: string): Promise<void>;
}
export class TerminalStore implements ITerminalStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.boundary(async () => {
			await this.database.run(
				"CREATE TABLE IF NOT EXISTS terminal_sessions (id TEXT PRIMARY KEY, workspaceId TEXT NOT NULL REFERENCES workspaces(id), status TEXT NOT NULL CHECK(status IN ('starting','running','exited','closed','lost')), createdAt TEXT NOT NULL, endedAt TEXT, exitCode INTEGER, cols INTEGER NOT NULL, rows INTEGER NOT NULL)",
			);
			await this.database.run(
				"CREATE UNIQUE INDEX IF NOT EXISTS terminal_active_workspace ON terminal_sessions(workspaceId) WHERE status IN ('starting','running')",
			);
		});
	}
	async insert(session: TerminalSession): Promise<void> {
		await this.boundary(async () => {
			terminalSessionSchema.parse(session);
			if (
				(await this.database.run(
					"INSERT INTO terminal_sessions (id,workspaceId,status,createdAt,endedAt,exitCode,cols,rows) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM terminal_sessions)<1000",
					[
						session.id,
						session.workspaceId,
						session.status,
						session.createdAt,
						session.endedAt ?? null,
						session.exitCode ?? null,
						session.cols,
						session.rows,
					],
				)) !== 1
			)
				throw new TerminalError("terminal-capacity");
		});
	}
	async update(session: TerminalSession): Promise<void> {
		await this.boundary(async () => {
			terminalSessionSchema.parse(session);
			if (
				(await this.database.run(
					"UPDATE terminal_sessions SET status=?,endedAt=?,exitCode=?,cols=?,rows=? WHERE id=? AND workspaceId=?",
					[
						session.status,
						session.endedAt ?? null,
						session.exitCode ?? null,
						session.cols,
						session.rows,
						session.id,
						session.workspaceId,
					],
				)) !== 1
			)
				throw new Error("Terminal record missing");
		});
	}
	async get(id: string): Promise<TerminalSession | undefined> {
		return this.boundary(async () =>
			this.decode((await this.database.all("SELECT * FROM terminal_sessions WHERE id=?", [id])).at(0)),
		);
	}
	async latest(workspaceId: string): Promise<TerminalSession | undefined> {
		return this.boundary(async () =>
			this.decode(
				(
					await this.database.all(
						"SELECT * FROM terminal_sessions WHERE workspaceId=? ORDER BY rowid DESC LIMIT 1",
						[workspaceId],
					)
				).at(0),
			),
		);
	}
	async loseActive(endedAt: string): Promise<void> {
		await this.boundary(async () => {
			await this.database.run(
				"UPDATE terminal_sessions SET status='lost',endedAt=? WHERE status IN ('starting','running')",
				[endedAt],
			);
		});
	}
	private decode(row: unknown): TerminalSession | undefined {
		if (row === undefined) return undefined;
		const data = terminalSessionSchema
			.extend({
				endedAt: terminalSessionSchema.shape.endedAt.nullable(),
				exitCode: terminalSessionSchema.shape.exitCode.nullable(),
			})
			.parse(row);
		return terminalSessionSchema.parse({
			...data,
			endedAt: data.endedAt ?? undefined,
			exitCode: data.exitCode ?? undefined,
		});
	}
	private async boundary<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			if (cause instanceof TerminalError) throw cause;
			throw new TerminalError("terminal-unavailable", { cause });
		}
	}
}
