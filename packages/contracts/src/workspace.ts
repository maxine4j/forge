import { z } from "zod";

// eslint-disable-next-line no-control-regex
const controlCharacters = /[\u0000-\u001f\u007f]/u;

export const workspaceIdSchema = z.uuid();
export const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
export const workspaceNameSchema = z.string().trim().min(1).max(120);
export const workspaceSchema = z.strictObject({
	id: workspaceIdSchema,
	projectId: z.uuid(),
	name: workspaceNameSchema,
	branch: z.string().regex(/^forge\/workspace\/[a-f0-9-]{36}$/),
	baseSha: gitShaSchema.optional(),
	head: gitShaSchema.optional(),
	createdAt: z.iso.datetime(),
	status: z.enum(["creating", "ready", "failed", "archived"]),
});
export const workspacesSchema = z.array(workspaceSchema).max(1000);
export const createWorkspaceSchema = z.strictObject({ name: workspaceNameSchema });
export const filePathSchema = z
	.string()
	.min(1)
	.max(1024)
	.refine(
		(path) =>
			!path.startsWith("/")
			&& !path.includes("\\")
			&& !controlCharacters.test(path)
			&& path
				.split("/")
				.every(
					(part) =>
						part !== ""
						&& part !== "."
						&& part !== ".."
						&& part.toLowerCase() !== ".git"
						&& !part.startsWith(".forge-"),
				),
	);
export const treePathSchema = z.union([z.literal(""), filePathSchema]);
export const workspaceFileSchema = z.strictObject({
	path: filePathSchema,
	content: z.string().max(262144),
	version: z.string().regex(/^[a-f0-9]{64}$/),
});
export const createWorkspaceFileSchema = z.strictObject({ path: filePathSchema, content: z.string().max(262144) });
export const saveWorkspaceFileSchema = createWorkspaceFileSchema.extend({
	version: z.string().regex(/^[a-f0-9]{64}$/),
});
export const workspaceTreeSchema = z.strictObject({
	path: treePathSchema,
	entries: z
		.array(
			z.strictObject({
				name: z.string(),
				path: filePathSchema,
				kind: z.enum(["file", "directory"]),
				lastChangedAt: z.iso.datetime().optional(),
			}),
		)
		.max(1000),
	truncated: z.boolean(),
});
export const workspacePathsSchema = z.strictObject({ paths: z.array(filePathSchema).min(1).max(100) });
export const workspaceCommitSchema = z.strictObject({
	message: z.string().trim().min(1).max(4096),
	expectedHead: gitShaSchema,
});
export const diffSectionSchema = z.strictObject({
	files: z.array(z.strictObject({ path: filePathSchema, binary: z.boolean() })).max(100),
	patch: z.string().max(262144),
	truncated: z.boolean(),
});
export const workspaceDiffSchema = z.strictObject({
	comparison: z.literal("merge-base(main, workspace)..workspace"),
	baseSha: gitShaSchema,
	head: gitShaSchema,
	branch: diffSectionSchema,
	staged: diffSectionSchema,
	unstaged: diffSectionSchema,
	untracked: diffSectionSchema,
});
