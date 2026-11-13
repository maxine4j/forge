import { z } from "zod";

export * from "./workspace.ts";
export * from "./repository.ts";
export * from "./cost.ts";
export type {
	RepositoryCommitInput,
	Workspace,
	CreateWorkspace,
	WorkspaceFile,
	CreateWorkspaceFile,
	SaveWorkspaceFile,
	WorkspaceTree,
	WorkspacePaths,
	WorkspaceCommit,
	DiffSection,
	WorkspaceDiff,
} from "./types.ts";

// Control characters are intentionally rejected at this untrusted browser boundary.
// eslint-disable-next-line no-control-regex
const controlCharacters = /[\u0000-\u001f\u007f]/u;
export const projectIdSchema = z.uuid();
export const remoteSourceSchema = z
	.string()
	.max(2048)
	.url()
	.refine((source) => {
		if (!URL.canParse(source)) return false;
		const url = new URL(source);
		return (
			url.protocol === "https:"
			&& !url.username
			&& !url.password
			&& !url.search
			&& !url.hash
			&& !/\s/u.test(source)
			&& !controlCharacters.test(source)
		);
	}, "Use a credential-free HTTPS Git URL without query or fragment");
export const createProjectSchema = z.strictObject({
	name: z
		.string()
		.trim()
		.min(1)
		.max(120)
		.refine((name) => !controlCharacters.test(name)),
	source: remoteSourceSchema.optional(),
});
export const projectSchema = z.strictObject({
	id: projectIdSchema,
	name: z.string().min(1).max(120),
	status: z.enum(["creating", "ready", "failed"]),
	createdAt: z.iso.datetime(),
	upstreamSyncAvailable: z.literal(true).optional(),
});
export const projectsSchema = z.array(projectSchema).max(1000);
export const apiErrorSchema = z.strictObject({
	error: z.enum([
		"invalid-request",
		"access-denied",
		"project-not-found",
		"project-unavailable",
		"internal-error",
		"workspace-not-found",
		"workspace-unavailable",
		"workspace-conflict",
		"file-not-found",
		"file-conflict",
		"file-unsupported",
	]),
});

export const accountProviderSchema = z.enum(["codex", "github"]);
export const accountStatusSchema = z.strictObject({
	connection: z.enum(["available", "unavailable"]),
	account: z.strictObject({ name: z.string().min(1).max(320) }).optional(),
	login: z.strictObject({
		state: z.enum(["idle", "pending", "completed", "failed", "cancelled", "uncertain"]),
		verificationUrl: z.url().max(2048).optional(),
		userCode: z
			.string()
			.regex(/^[A-Z0-9-]{1,128}$/)
			.optional(),
		failure: z.enum(["login-failed", "verification-failed", "connection-lost", "unavailable"]).optional(),
	}),
});
export const accountsStatusSchema = z.strictObject({ codex: accountStatusSchema, github: accountStatusSchema });
export type { AccountProvider, AccountStatus, AccountsStatus, CreateProject, Project } from "./types.ts";
