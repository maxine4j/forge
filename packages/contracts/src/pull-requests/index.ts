import { z } from "zod";

import { diffSectionSchema, gitShaSchema, workspaceIdSchema } from "../workspace.ts";

export const revisionSchema = z.strictObject({ baseSha: gitShaSchema, head: gitShaSchema, mergeBase: gitShaSchema });
export const expectedRevisionSchema = z.strictObject({ expectedHead: gitShaSchema, expectedBase: gitShaSchema });
export const createPullRequestSchema = expectedRevisionSchema.extend({
	workspaceId: workspaceIdSchema,
	title: z.string().trim().min(1).max(120),
	body: z.string().max(8192),
});
export const updatePullRequestSchema = expectedRevisionSchema.extend({
	title: z.string().trim().min(1).max(120).optional(),
	body: z.string().max(8192).optional(),
	status: z.enum(["open", "closed"]).optional(),
});
export const commentSchema = expectedRevisionSchema.extend({ body: z.string().trim().min(1).max(8192) });
export const reviewSchema = expectedRevisionSchema.extend({
	body: z.string().max(8192),
	decision: z.enum(["approve", "request-changes"]),
});
export const pullRequestRecordSchema = z.strictObject({
	id: z.uuid(),
	projectId: z.uuid(),
	workspaceId: workspaceIdSchema,
	branch: z.string().regex(/^forge\/workspace\/[a-f0-9-]{36}$/),
	base: z.literal("main"),
	title: z.string().trim().min(1).max(120),
	body: z.string().max(8192),
	status: z.enum(["open", "closed"]),
	createdAt: z.iso.datetime(),
});
export const discussionRecordSchema = z.strictObject({
	id: z.uuid(),
	pullRequestId: z.uuid(),
	kind: z.enum(["comment", "approve", "request-changes"]),
	body: z.string().max(8192),
	revision: revisionSchema,
	createdAt: z.iso.datetime(),
});
export const pullRequestSchema = pullRequestRecordSchema.extend({
	revision: revisionSchema.optional(),
	approval: z.enum(["none", "approved", "requested-changes", "stale", "unavailable"]),
	discussion: z.array(discussionRecordSchema).max(1000),
});
export const pullRequestsSchema = z.array(pullRequestRecordSchema).max(1000);
export const pullRequestDiffSchema = z.strictObject({
	comparison: z.literal("merge-base(main, workspace)..workspace (committed)"),
	revision: revisionSchema,
	diff: diffSectionSchema,
});
export const pullRequestPreviewSchema = z.strictObject({ revision: revisionSchema, hasChanges: z.boolean() });
export type {
	PullRequestSummary,
	PullRequestDiscussion,
	Revision,
	ExpectedRevision,
	CreatePullRequest,
	UpdatePullRequest,
	PullRequestComment,
	PullRequestReview,
	PullRequest,
	PullRequestDiff,
	PullRequestPreview,
} from "./types.ts";
