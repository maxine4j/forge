import type { z } from "zod";

import type { repositoryCommitInputSchema } from "./repository.ts";

export type RepositoryCommitInput = z.infer<typeof repositoryCommitInputSchema>;

import type {
	workspaceSchema,
	createWorkspaceSchema,
	workspaceFileSchema,
	createWorkspaceFileSchema,
	saveWorkspaceFileSchema,
	workspaceTreeSchema,
	workspacePathsSchema,
	workspaceCommitSchema,
	diffSectionSchema,
	workspaceDiffSchema,
} from "./workspace.ts";

export type Workspace = z.infer<typeof workspaceSchema>;
export type CreateWorkspace = z.infer<typeof createWorkspaceSchema>;
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;
export type CreateWorkspaceFile = z.infer<typeof createWorkspaceFileSchema>;
export type SaveWorkspaceFile = z.infer<typeof saveWorkspaceFileSchema>;
export type WorkspaceTree = z.infer<typeof workspaceTreeSchema>;
export type WorkspacePaths = z.infer<typeof workspacePathsSchema>;
export type WorkspaceCommit = z.infer<typeof workspaceCommitSchema>;
export type DiffSection = z.infer<typeof diffSectionSchema>;
export type WorkspaceDiff = z.infer<typeof workspaceDiffSchema>;

export interface CreateProject {
	name: string;
	source?: string;
}
export interface Project {
	id: string;
	name: string;
	status: "creating" | "ready" | "failed";
	createdAt: string;
	githubSyncAvailable?: true;
}

export type AccountProvider = "codex" | "github";
export interface AccountStatus {
	connection: "available" | "unavailable";
	account?: { name: string };
	login: {
		state: "idle" | "pending" | "completed" | "failed" | "cancelled" | "uncertain";
		verificationUrl?: string;
		userCode?: string;
		/** Fixed actionable code; never CLI diagnostics. */
		failure?: "login-failed" | "verification-failed" | "connection-lost" | "unavailable";
	};
}
export interface AccountsStatus {
	codex: AccountStatus;
	github: AccountStatus;
}
