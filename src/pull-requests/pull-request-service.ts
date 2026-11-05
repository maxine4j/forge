import {
	createPullRequestSchema,
	updatePullRequestSchema,
	commentSchema,
	reviewSchema,
	type CreatePullRequest,
	type UpdatePullRequest,
	type PullRequestComment,
	type PullRequestReview,
	type PullRequest,
	type PullRequestDiff,
	type PullRequestPreview,
	type ExpectedRevision,
} from "@forge/contracts/pull-requests";
import { z } from "zod";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import { PullRequestError } from "./errors.ts";
import type { IPullRequestClient } from "./pull-request-client.ts";
import type { IPullRequestStore } from "./pull-request-store.ts";
import type { PullRequestRecord, PullRequestSource, DiscussionRecord } from "./types.ts";

export interface IPullRequestService {
	/** All operations recheck owner. Writes serialize; Git and SQLite are not one transaction.
	 * A review records observed immutable SHAs; later reads invalidate it on either ref changing.
	 * Throws PullRequestError or AccessDeniedError. No operation writes Git or merges main. */
	create(actor: Actor, projectId: string, input: CreatePullRequest): Promise<PullRequest>;
	/** Metadata only. Fetch detail for actual current approval and discussion. */
	list(actor: Actor, projectId: string): Promise<PullRequestRecord[]>;
	get(actor: Actor, id: string): Promise<PullRequest>;
	update(actor: Actor, id: string, input: UpdatePullRequest): Promise<PullRequest>;
	comment(actor: Actor, id: string, input: PullRequestComment): Promise<PullRequest>;
	review(actor: Actor, id: string, input: PullRequestReview): Promise<PullRequest>;
	diff(actor: Actor, id: string): Promise<PullRequestDiff>;
	preview(actor: Actor, workspaceId: string): Promise<PullRequestPreview>;
}
export class PullRequestService implements IPullRequestService {
	private tail: Promise<unknown> = Promise.resolve();
	private queued = 0;
	constructor(
		private readonly store: IPullRequestStore,
		private readonly client: IPullRequestClient,
		private readonly access: IAccessService,
		private readonly generateId: () => string,
		private readonly now: () => Date,
	) {}
	async create(actor: Actor, projectId: string, input: CreatePullRequest): Promise<PullRequest> {
		this.access.assertOwner(actor);
		const data = this.parse(createPullRequestSchema, input);
		this.id(projectId);
		return this.serialize(async () => {
			const source = await this.source(actor, data.workspaceId);
			if (source.projectId !== projectId) throw new PullRequestError("invalid-request");
			this.expected(source, data);
			if (!source.hasChanges) throw new PullRequestError("no-changes");
			const record: PullRequestRecord = {
				id: this.id(this.generateId()),
				projectId,
				workspaceId: data.workspaceId,
				branch: source.branch,
				base: "main",
				title: data.title,
				body: data.body,
				status: "open",
				createdAt: this.now().toISOString(),
			};
			await this.store.insert(record);
			return this.present(actor, record);
		});
	}
	async list(actor: Actor, projectId: string): Promise<PullRequestRecord[]> {
		this.access.assertOwner(actor);
		this.id(projectId);
		return this.serialize(async () => this.store.list(projectId));
	}
	async get(actor: Actor, id: string): Promise<PullRequest> {
		this.access.assertOwner(actor);
		return this.serialize(async () => this.present(actor, await this.require(id)));
	}
	async update(actor: Actor, id: string, input: UpdatePullRequest): Promise<PullRequest> {
		this.access.assertOwner(actor);
		const data = this.parse(updatePullRequestSchema, input);
		return this.serialize(async () => {
			const record = await this.require(id);
			this.expected(await this.source(actor, record.workspaceId, record), data);
			const changed = {
				...record,
				title: data.title ?? record.title,
				body: data.body ?? record.body,
				status: data.status ?? record.status,
			};
			await this.store.update(changed);
			return this.present(actor, changed);
		});
	}
	async comment(actor: Actor, id: string, input: PullRequestComment): Promise<PullRequest> {
		this.access.assertOwner(actor);
		const data = this.parse(commentSchema, input);
		return this.discuss(actor, id, data, "comment");
	}
	async review(actor: Actor, id: string, input: PullRequestReview): Promise<PullRequest> {
		this.access.assertOwner(actor);
		const data = this.parse(reviewSchema, input);
		return this.discuss(actor, id, data, data.decision);
	}
	async diff(actor: Actor, id: string): Promise<PullRequestDiff> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const record = await this.require(id);
			await this.source(actor, record.workspaceId, record);
			return this.client.diff(actor, record.workspaceId);
		});
	}
	async preview(actor: Actor, workspaceId: string): Promise<PullRequestPreview> {
		this.access.assertOwner(actor);
		this.id(workspaceId);
		return this.serialize(async () => {
			const source = await this.source(actor, workspaceId);
			return { revision: source.revision, hasChanges: source.hasChanges };
		});
	}
	private async discuss(
		actor: Actor,
		id: string,
		data: ExpectedRevision & { body: string },
		kind: DiscussionRecord["kind"],
	): Promise<PullRequest> {
		return this.serialize(async () => {
			const record = await this.require(id);
			if (record.status !== "open") throw new PullRequestError("pull-request-closed");
			const source = await this.source(actor, record.workspaceId, record);
			this.expected(source, data);
			await this.store.append({
				id: this.id(this.generateId()),
				pullRequestId: id,
				kind,
				body: data.body,
				revision: source.revision,
				createdAt: this.now().toISOString(),
			});
			return this.present(actor, record);
		});
	}
	private async present(actor: Actor, record: PullRequestRecord): Promise<PullRequest> {
		const discussion = await this.store.discussion(record.id);
		let source: PullRequestSource;
		try {
			source = await this.source(actor, record.workspaceId, record);
		} catch (error) {
			if (!(error instanceof PullRequestError) || error.code !== "pull-request-unavailable") throw error;
			return { ...record, discussion, approval: "unavailable" };
		}
		const review = discussion.filter((entry) => entry.kind !== "comment").at(-1);
		const approval = !review
			? "none"
			: review.revision.head !== source.revision.head || review.revision.baseSha !== source.revision.baseSha
				? "stale"
				: review.kind === "approve"
					? "approved"
					: "requested-changes";
		return { ...record, discussion, revision: source.revision, approval };
	}
	private async source(actor: Actor, workspaceId: string, record?: PullRequestRecord): Promise<PullRequestSource> {
		try {
			const source = await this.client.inspect(actor, workspaceId);
			if (
				source.workspaceId !== workspaceId
				|| source.branch !== `forge/workspace/${workspaceId}`
				|| (record
					&& (record.projectId !== source.projectId
						|| record.branch !== source.branch
						|| record.base !== "main"))
			)
				throw new PullRequestError("pull-request-unavailable");
			return source;
		} catch (cause) {
			throw new PullRequestError("pull-request-unavailable", { cause });
		}
	}
	private expected(source: PullRequestSource, input: ExpectedRevision): void {
		if (source.revision.head !== input.expectedHead || source.revision.baseSha !== input.expectedBase)
			throw new PullRequestError("revision-conflict");
	}
	private async require(id: string): Promise<PullRequestRecord> {
		const record = await this.store.get(this.id(id));
		if (!record) throw new PullRequestError("pull-request-not-found");
		return record;
	}
	private id(value: string): string {
		return this.parse(z.uuid(), value);
	}
	private parse<T>(schema: z.ZodType<T>, value: unknown): T {
		const result = schema.safeParse(value);
		if (!result.success) throw new PullRequestError("invalid-request");
		return result.data;
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		if (this.queued >= 100) return Promise.reject(new PullRequestError("pull-request-unavailable"));
		this.queued++;
		const next = this.tail.then(operation).finally(() => {
			this.queued--;
		});
		this.tail = next.catch(() => {});
		return next;
	}
}
