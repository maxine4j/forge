import { createLogger } from "@forge/backend-infrastructure/logger";
import {
	createPullRequestSchema,
	updatePullRequestSchema,
	commentSchema,
	reviewSchema,
	pullRequestSchema,
	pullRequestsSchema,
	pullRequestDiffSchema,
	pullRequestPreviewSchema,
} from "@forge/contracts/pull-requests";
import Router from "@koa/router";
import type { z } from "zod";

import { AccessDeniedError } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import { PullRequestError } from "./errors.ts";
import type { IPullRequestService } from "./pull-request-service.ts";

export class PullRequestRouter implements IHttpRouter {
	private readonly log = createLogger(PullRequestRouter.name);
	constructor(private readonly service: IPullRequestService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.use(async (ctx, next) => {
			try {
				await next();
			} catch (error) {
				if (error instanceof AccessDeniedError) throw error;
				this.log.warn({ err: error }, "Pull request operation failed");
				const code = error instanceof PullRequestError ? error.code : "pull-request-unavailable";
				ctx.status =
					code === "invalid-request"
						? 400
						: code === "pull-request-not-found"
							? 404
							: code === "pull-request-unavailable"
								? 503
								: 409;
				ctx.body = { error: code };
			}
		});
		router.get("/api/projects/:projectId/pull-requests", async (ctx) => {
			ctx.body = pullRequestsSchema.parse(await this.service.list(ctx.state.actor, ctx.params["projectId"]!));
		});
		router.post("/api/projects/:projectId/pull-requests", async (ctx) => {
			ctx.body = pullRequestSchema.parse(
				await this.service.create(
					ctx.state.actor,
					ctx.params["projectId"]!,
					this.parse(createPullRequestSchema, ctx.request.body),
				),
			);
			ctx.status = 201;
		});
		router.get("/api/workspaces/:workspaceId/pull-request-revision", async (ctx) => {
			ctx.body = pullRequestPreviewSchema.parse(
				await this.service.preview(ctx.state.actor, ctx.params["workspaceId"]!),
			);
		});
		router.get("/api/pull-requests/:id", async (ctx) => {
			ctx.body = pullRequestSchema.parse(await this.service.get(ctx.state.actor, ctx.params["id"]!));
		});
		router.patch("/api/pull-requests/:id", async (ctx) => {
			ctx.body = pullRequestSchema.parse(
				await this.service.update(
					ctx.state.actor,
					ctx.params["id"]!,
					this.parse(updatePullRequestSchema, ctx.request.body),
				),
			);
		});
		router.get("/api/pull-requests/:id/diff", async (ctx) => {
			ctx.body = pullRequestDiffSchema.parse(await this.service.diff(ctx.state.actor, ctx.params["id"]!));
		});
		router.post("/api/pull-requests/:id/comments", async (ctx) => {
			ctx.body = pullRequestSchema.parse(
				await this.service.comment(
					ctx.state.actor,
					ctx.params["id"]!,
					this.parse(commentSchema, ctx.request.body),
				),
			);
		});
		router.post("/api/pull-requests/:id/reviews", async (ctx) => {
			ctx.body = pullRequestSchema.parse(
				await this.service.review(
					ctx.state.actor,
					ctx.params["id"]!,
					this.parse(reviewSchema, ctx.request.body),
				),
			);
		});
		return router;
	}
	private parse<T>(schema: z.ZodType<T>, input: unknown): T {
		const parsed = schema.safeParse(input);
		if (!parsed.success) throw new PullRequestError("invalid-request");
		return parsed.data;
	}
}
