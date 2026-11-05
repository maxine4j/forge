import type { DiffSection } from "../types.ts";

export interface Revision {
	baseSha: string;
	head: string;
	mergeBase: string;
}
export interface ExpectedRevision {
	expectedHead: string;
	expectedBase: string;
}
export interface CreatePullRequest extends ExpectedRevision {
	workspaceId: string;
	title: string;
	body: string;
}
export interface UpdatePullRequest extends ExpectedRevision {
	title?: string;
	body?: string;
	status?: "open" | "closed";
}
export interface PullRequestComment extends ExpectedRevision {
	body: string;
}
export interface PullRequestReview extends ExpectedRevision {
	body: string;
	decision: "approve" | "request-changes";
}
export interface PullRequestSummary {
	id: string;
	projectId: string;
	workspaceId: string;
	branch: string;
	base: "main";
	title: string;
	body: string;
	status: "open" | "closed";
	createdAt: string;
}
export interface PullRequestDiscussion {
	id: string;
	pullRequestId: string;
	kind: "comment" | "approve" | "request-changes";
	body: string;
	revision: Revision;
	createdAt: string;
}
export interface PullRequest extends PullRequestSummary {
	revision?: Revision;
	approval: "none" | "approved" | "requested-changes" | "stale" | "unavailable";
	discussion: PullRequestDiscussion[];
}
export interface PullRequestDiff {
	comparison: "merge-base(main, workspace)..workspace (committed)";
	revision: Revision;
	diff: DiffSection;
}
export interface PullRequestPreview {
	revision: Revision;
	hasChanges: boolean;
}
