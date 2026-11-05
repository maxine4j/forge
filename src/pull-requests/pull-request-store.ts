import { pullRequestRecordSchema, discussionRecordSchema } from "@forge/contracts/pull-requests";

import type { IDatabase } from "../database/sqlite-database.ts";
import { PullRequestError } from "./errors.ts";
import type { PullRequestRecord, DiscussionRecord } from "./types.ts";

export interface IPullRequestStore {
	/** At most 1000 PRs and 1000 discussion entries per PR. Preserves closed and unavailable PRs. Throws PullRequestError. */
	insert(record: PullRequestRecord): Promise<void>;
	get(id: string): Promise<PullRequestRecord | undefined>;
	list(projectId: string): Promise<PullRequestRecord[]>;
	update(record: PullRequestRecord): Promise<void>;
	append(record: DiscussionRecord): Promise<void>;
	discussion(id: string): Promise<DiscussionRecord[]>;
}
export class PullRequestStore implements IPullRequestStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		await this.boundary(async () =>
			this.database.transaction([
				{
					sql: "CREATE TABLE IF NOT EXISTS pull_requests (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), workspaceId TEXT NOT NULL REFERENCES workspaces(id), branch TEXT NOT NULL, base TEXT NOT NULL CHECK(base = 'main'), title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('open','closed')), createdAt TEXT NOT NULL)",
				},
				{
					sql: "CREATE TABLE IF NOT EXISTS pull_request_discussion (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, pullRequestId TEXT NOT NULL REFERENCES pull_requests(id), kind TEXT NOT NULL CHECK(kind IN ('comment','approve','request-changes')), body TEXT NOT NULL, baseSha TEXT NOT NULL, head TEXT NOT NULL, mergeBase TEXT NOT NULL, createdAt TEXT NOT NULL)",
				},
			]),
		);
	}
	async insert(record: PullRequestRecord): Promise<void> {
		await this.boundary(async () => {
			pullRequestRecordSchema.parse(record);
			if (
				(await this.database.run(
					"INSERT INTO pull_requests SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM pull_requests) < 1000",
					[
						record.id,
						record.projectId,
						record.workspaceId,
						record.branch,
						record.base,
						record.title,
						record.body,
						record.status,
						record.createdAt,
					],
				)) !== 1
			)
				throw new Error("PR capacity");
		});
	}
	async get(id: string): Promise<PullRequestRecord | undefined> {
		return this.boundary(async () => {
			const row = (await this.database.all("SELECT * FROM pull_requests WHERE id = ?", [id])).at(0);
			return row ? pullRequestRecordSchema.parse(row) : undefined;
		});
	}
	async list(projectId: string): Promise<PullRequestRecord[]> {
		return this.boundary(async () =>
			(
				await this.database.all("SELECT * FROM pull_requests WHERE projectId = ? ORDER BY createdAt, id", [
					projectId,
				])
			).map((row) => pullRequestRecordSchema.parse(row)),
		);
	}
	async update(record: PullRequestRecord): Promise<void> {
		await this.boundary(async () => {
			pullRequestRecordSchema.parse(record);
			if (
				(await this.database.run(
					"UPDATE pull_requests SET title = ?, body = ?, status = ? WHERE id = ? AND projectId = ? AND workspaceId = ? AND branch = ? AND base = 'main'",
					[
						record.title,
						record.body,
						record.status,
						record.id,
						record.projectId,
						record.workspaceId,
						record.branch,
					],
				)) !== 1
			)
				throw new Error("PR missing");
		});
	}
	async append(record: DiscussionRecord): Promise<void> {
		await this.boundary(async () => {
			discussionRecordSchema.parse(record);
			if (
				(await this.database.run(
					"INSERT INTO pull_request_discussion (id,pullRequestId,kind,body,baseSha,head,mergeBase,createdAt) SELECT ?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM pull_request_discussion WHERE pullRequestId = ?) < 1000",
					[
						record.id,
						record.pullRequestId,
						record.kind,
						record.body,
						record.revision.baseSha,
						record.revision.head,
						record.revision.mergeBase,
						record.createdAt,
						record.pullRequestId,
					],
				)) !== 1
			)
				throw new Error("Discussion capacity");
		});
	}
	async discussion(id: string): Promise<DiscussionRecord[]> {
		return this.boundary(async () =>
			(
				await this.database.all(
					"SELECT id,pullRequestId,kind,body,baseSha,head,mergeBase,createdAt FROM pull_request_discussion WHERE pullRequestId = ? ORDER BY sequence",
					[id],
				)
			).map((row) => {
				const flat = discussionRecordSchema
					.omit({ revision: true })
					.extend({
						baseSha: discussionRecordSchema.shape.revision.shape.baseSha,
						head: discussionRecordSchema.shape.revision.shape.head,
						mergeBase: discussionRecordSchema.shape.revision.shape.mergeBase,
					})
					.parse(row);
				const { baseSha, head, mergeBase, ...entry } = flat;
				return { ...entry, revision: { baseSha, head, mergeBase } };
			}),
		);
	}
	private async boundary<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			throw new PullRequestError("pull-request-unavailable", { cause });
		}
	}
}
