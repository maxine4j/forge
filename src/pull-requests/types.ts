import type { Revision, PullRequest } from "@forge/contracts/pull-requests";
export type PullRequestRecord = Omit<PullRequest, "revision" | "approval" | "discussion">;
export type DiscussionRecord = PullRequest["discussion"][number];
export interface PullRequestSource {
	projectId: string;
	workspaceId: string;
	branch: string;
	revision: Revision;
	hasChanges: boolean;
}
