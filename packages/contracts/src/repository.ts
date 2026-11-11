import { z } from "zod";

import { filePathSchema, gitShaSchema, treePathSchema } from "./workspace.ts";

export const branchNameSchema = z
	.string()
	.min(1)
	.max(255)
	.refine(
		(name) =>
			!name.startsWith("-")
			&& !name.startsWith("/")
			&& !name.endsWith("/")
			&& !name.endsWith(".")
			// eslint-disable-next-line no-control-regex
			&& !/[\s~^:?*[\\\u0000-\u001f\u007f]/u.test(name)
			&& !name.includes("..")
			&& !name.includes("@{")
			&& name.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock")),
	);
export const repositoryCommitSchema = z.strictObject({
	sha: gitShaSchema,
	subject: z.string().max(4096),
	author: z.string().max(1024),
	date: z.iso.datetime({ offset: true }),
});
export const repositoryBranchesSchema = z
	.array(z.strictObject({ name: branchNameSchema, sha: gitShaSchema }))
	.max(1000);
export const repositoryTreeSchema = z.strictObject({
	path: treePathSchema,
	head: gitShaSchema,
	entries: z
		.array(
			z.strictObject({
				name: z.string(),
				path: filePathSchema,
				kind: z.enum(["file", "directory"]),
				lastCommit: repositoryCommitSchema.optional(),
			}),
		)
		.max(1000),
	truncated: z.boolean(),
});
export const repositoryHistorySchema = z.strictObject({
	head: gitShaSchema,
	commits: z.array(repositoryCommitSchema).max(100),
	hasMore: z.boolean(),
});
export const repositoryFileSchema = z.strictObject({ path: filePathSchema, content: z.string().max(262144) });
export const repositoryCommitInputSchema = z
	.strictObject({
		branch: branchNameSchema,
		expectedHead: gitShaSchema,
		message: z.string().trim().min(1).max(4096),
		files: z
			.array(repositoryFileSchema.refine((file) => new TextEncoder().encode(file.content).length <= 262144))
			.min(1)
			.max(100),
	})
	.refine(({ files }) => new Set(files.map((file) => file.path)).size === files.length)
	.refine(
		({ files }) => files.reduce((size, file) => size + new TextEncoder().encode(file.content).length, 0) <= 1048576,
	)
	.refine(({ files }) => files.every((file) => !file.content.includes("\0")));
export const repositoryCommitResultSchema = z.strictObject({ head: gitShaSchema });
export const githubSyncStatusSchema = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("unconfigured") }),
	z.strictObject({ state: z.literal("unavailable") }),
	z.strictObject({ state: z.literal("ready"), ahead: z.int().nonnegative(), behind: z.int().nonnegative() }),
]);
export const githubSyncResultSchema = z.strictObject({ head: gitShaSchema });
export type GithubSyncStatus = z.infer<typeof githubSyncStatusSchema>;
export type RepositoryCommit = z.infer<typeof repositoryCommitSchema>;
export type RepositoryBranch = z.infer<typeof repositoryBranchesSchema>[number];
export type RepositoryTree = z.infer<typeof repositoryTreeSchema>;
export type RepositoryHistory = z.infer<typeof repositoryHistorySchema>;
export type RepositoryFile = z.infer<typeof repositoryFileSchema>;
