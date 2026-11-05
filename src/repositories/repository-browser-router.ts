import {
	repositoryBranchesSchema,
	repositoryFileSchema,
	repositoryHistorySchema,
	repositoryTreeSchema,
	repositoryCommitInputSchema,
	repositoryCommitResultSchema,
} from "@forge/contracts";
import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import { WorkspaceError } from "../workspaces/errors.ts";
import type { IRepositoryBrowserService } from "./repository-browser-service.ts";

export class RepositoryBrowserRouter implements IHttpRouter {
	constructor(private readonly browser: IRepositoryBrowserService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>({ prefix: "/api/projects/:id/repository" });
		router.post("/commit", async (ctx) => {
			const input = repositoryCommitInputSchema.safeParse(ctx.request.body);
			if (!input.success) throw new WorkspaceError("invalid-request");
			ctx.body = repositoryCommitResultSchema.parse(
				await this.browser.commit(ctx.state.actor, ctx.params["id"]!, input.data),
			);
		});
		router.get("/branches", async (ctx) => {
			ctx.body = repositoryBranchesSchema.parse(await this.browser.branches(ctx.state.actor, ctx.params["id"]!));
		});
		router.get("/tree", async (ctx) => {
			ctx.body = repositoryTreeSchema.parse(
				await this.browser.tree(
					ctx.state.actor,
					ctx.params["id"]!,
					this.query(ctx.query["branch"]),
					this.query(ctx.query["path"], ""),
				),
			);
		});
		router.get("/file", async (ctx) => {
			ctx.body = repositoryFileSchema.parse(
				await this.browser.file(
					ctx.state.actor,
					ctx.params["id"]!,
					this.query(ctx.query["branch"]),
					this.query(ctx.query["path"]),
				),
			);
		});
		router.get("/history", async (ctx) => {
			const offset = this.query(ctx.query["offset"], "0");
			if (!/^\d{1,6}$/u.test(offset)) throw new WorkspaceError("invalid-request");
			ctx.body = repositoryHistorySchema.parse(
				await this.browser.history(
					ctx.state.actor,
					ctx.params["id"]!,
					this.query(ctx.query["branch"]),
					Number(offset),
				),
			);
		});
		return router;
	}
	private query(value: unknown, fallback?: string): string {
		if (value === undefined && fallback !== undefined) return fallback;
		if (typeof value !== "string") throw new WorkspaceError("invalid-request");
		return value;
	}
}
