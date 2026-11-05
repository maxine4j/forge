import {
	createWorkspaceSchema,
	createWorkspaceFileSchema,
	saveWorkspaceFileSchema,
	workspaceSchema,
	workspacesSchema,
	workspaceFileSchema,
	workspaceTreeSchema,
	workspaceDiffSchema,
	workspacePathsSchema,
	workspaceCommitSchema,
} from "@forge/contracts";
import Router from "@koa/router";
import type { z } from "zod";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import { WorkspaceError } from "./errors.ts";
import type { IWorkspaceService } from "./workspace-service.ts";

export class WorkspaceRouter implements IHttpRouter {
	constructor(private readonly workspaces: IWorkspaceService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.get("/api/projects/:projectId/workspaces", async (ctx) => {
			ctx.body = workspacesSchema.parse(await this.workspaces.list(ctx.state.actor, ctx.params["projectId"]!));
		});
		router.post("/api/projects/:projectId/workspaces", async (ctx) => {
			ctx.body = workspaceSchema.parse(
				await this.workspaces.create(
					ctx.state.actor,
					ctx.params["projectId"]!,
					this.parse(createWorkspaceSchema, ctx.request.body),
				),
			);
			ctx.status = 201;
		});
		router.get("/api/workspaces/:id", async (ctx) => {
			ctx.body = workspaceSchema.parse(await this.workspaces.get(ctx.state.actor, ctx.params["id"]!));
		});
		router.patch("/api/workspaces/:id", async (ctx) => {
			ctx.body = workspaceSchema.parse(
				await this.workspaces.rename(
					ctx.state.actor,
					ctx.params["id"]!,
					this.parse(createWorkspaceSchema, ctx.request.body),
				),
			);
		});
		router.delete("/api/workspaces/:id", async (ctx) => {
			ctx.body = workspaceSchema.parse(await this.workspaces.archive(ctx.state.actor, ctx.params["id"]!));
		});
		router.post("/api/workspaces/:id/retry", async (ctx) => {
			ctx.body = workspaceSchema.parse(await this.workspaces.retry(ctx.state.actor, ctx.params["id"]!));
		});
		router.get("/api/workspaces/:id/tree", async (ctx) => {
			ctx.body = workspaceTreeSchema.parse(
				await this.workspaces.tree(ctx.state.actor, ctx.params["id"]!, this.queryPath(ctx.query["path"], "")),
			);
		});
		router.get("/api/workspaces/:id/file", async (ctx) => {
			ctx.body = workspaceFileSchema.parse(
				await this.workspaces.readFile(ctx.state.actor, ctx.params["id"]!, this.queryPath(ctx.query["path"])),
			);
		});
		router.post("/api/workspaces/:id/file", async (ctx) => {
			ctx.body = workspaceFileSchema.parse(
				await this.workspaces.createFile(
					ctx.state.actor,
					ctx.params["id"]!,
					this.parse(createWorkspaceFileSchema, ctx.request.body),
				),
			);
			ctx.status = 201;
		});
		router.put("/api/workspaces/:id/file", async (ctx) => {
			ctx.body = workspaceFileSchema.parse(
				await this.workspaces.saveFile(
					ctx.state.actor,
					ctx.params["id"]!,
					this.parse(saveWorkspaceFileSchema, ctx.request.body),
				),
			);
		});
		router.get("/api/workspaces/:id/diff", async (ctx) => {
			ctx.body = workspaceDiffSchema.parse(await this.workspaces.diff(ctx.state.actor, ctx.params["id"]!));
		});
		router.post("/api/workspaces/:id/stage", async (ctx) => {
			ctx.body = workspaceSchema.parse(
				await this.workspaces.stage(
					ctx.state.actor,
					ctx.params["id"]!,
					this.parse(workspacePathsSchema, ctx.request.body),
				),
			);
		});
		router.post("/api/workspaces/:id/unstage", async (ctx) => {
			ctx.body = workspaceSchema.parse(
				await this.workspaces.unstage(
					ctx.state.actor,
					ctx.params["id"]!,
					this.parse(workspacePathsSchema, ctx.request.body),
				),
			);
		});
		router.post("/api/workspaces/:id/commit", async (ctx) => {
			ctx.body = workspaceSchema.parse(
				await this.workspaces.commit(
					ctx.state.actor,
					ctx.params["id"]!,
					this.parse(workspaceCommitSchema, ctx.request.body),
				),
			);
		});
		return router;
	}
	private parse<T>(schema: z.ZodType<T>, value: unknown): T {
		const result = schema.safeParse(value);
		if (!result.success) throw new WorkspaceError("invalid-request");
		return result.data;
	}
	private queryPath(value: unknown, fallback?: string): string {
		if (value === undefined && fallback !== undefined) return fallback;
		if (typeof value !== "string") throw new WorkspaceError("invalid-request");
		return value;
	}
}
