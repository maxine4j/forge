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
const commitFileSchema = z.strictObject({
	path: z.string().min(1).max(4096),
	oldPath: z.string().max(4096).optional(),
	status: z.enum(["A", "D", "M", "R", "T"]),
	additions: z.int().nonnegative(),
	deletions: z.int().nonnegative(),
	binary: z.boolean(),
	oldMode: z
		.string()
		.regex(/^[0-7]{6}$/u)
		.optional(),
	newMode: z
		.string()
		.regex(/^[0-7]{6}$/u)
		.optional(),
});
export const commitDetailSchema = repositoryCommitSchema.extend({
	message: z.string(),
	parents: z.array(gitShaSchema),
	base: gitShaSchema.nullable(),
	files: z.array(commitFileSchema).max(1000),
	additions: z.int().nonnegative(),
	deletions: z.int().nonnegative(),
	truncated: z.boolean(),
});
export const commitPatchSchema = z.strictObject({
	path: z.string(),
	status: commitFileSchema.shape.status,
	binary: z.boolean(),
	submodule: z.boolean(),
	truncated: z.boolean(),
	oldMode: commitFileSchema.shape.oldMode,
	newMode: commitFileSchema.shape.newMode,
	additions: z.int().nonnegative(),
	deletions: z.int().nonnegative(),
	hunks: z
		.array(
			z.strictObject({
				header: z.string(),
				lines: z
					.array(
						z.strictObject({
							kind: z.enum(["context", "addition", "deletion", "marker"]),
							text: z.string().max(262144),
							old: z.int().nonnegative().optional(),
							new: z.int().nonnegative().optional(),
						}),
					)
					.max(1000),
			}),
		)
		.max(1000),
});
export type CommitDetail = z.infer<typeof commitDetailSchema>;
export type CommitPatch = z.infer<typeof commitPatchSchema>;
export const upstreamSyncStatusSchema = z.discriminatedUnion("state", [
	z.strictObject({ state: z.literal("unconfigured") }),
	z.strictObject({ state: z.literal("unavailable") }),
	z.strictObject({
		state: z.literal("ready"),
		branch: branchNameSchema,
		ahead: z.int().nonnegative(),
		behind: z.int().nonnegative(),
	}),
]);
export const upstreamSyncResultSchema = z.strictObject({ head: gitShaSchema, branch: branchNameSchema });
export type UpstreamSyncStatus = z.infer<typeof upstreamSyncStatusSchema>;
export type RepositoryCommit = z.infer<typeof repositoryCommitSchema>;
export type RepositoryBranch = z.infer<typeof repositoryBranchesSchema>[number];
export type RepositoryTree = z.infer<typeof repositoryTreeSchema>;
export type RepositoryHistory = z.infer<typeof repositoryHistorySchema>;
export type RepositoryFile = z.infer<typeof repositoryFileSchema>;
