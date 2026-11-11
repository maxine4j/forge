import { githubSyncResultSchema, githubSyncStatusSchema } from "@forge/contracts";
import Router from "@koa/router";
import { z } from "zod";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import { InvalidProjectError } from "../projects/errors.ts";
import type { IGithubSyncService } from "./github-sync-service.ts";

const emptyBody = z.union([z.undefined(), z.strictObject({})]);
const errors = {
	unconfigured: { status: 404, error: "github-sync-unconfigured" },
	unavailable: { status: 503, error: "github-sync-unavailable" },
	busy: { status: 409, error: "github-sync-busy" },
	conflict: { status: 409, error: "github-sync-conflict" },
	changed: { status: 409, error: "github-sync-changed" },
	"push-failed": { status: 502, error: "github-sync-push-failed" },
};

export class GithubSyncRouter implements IHttpRouter {
	constructor(private readonly sync: IGithubSyncService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>({ prefix: "/api/projects/:id/repository/github-sync" });
		router.get("/", async (ctx) => {
			ctx.body = githubSyncStatusSchema.parse(await this.sync.status(ctx.state.actor, ctx.params["id"]!));
		});
		router.post("/", async (ctx) => {
			if (!emptyBody.safeParse(ctx.request.body).success) throw new InvalidProjectError();
			const result = await this.sync.sync(ctx.state.actor, ctx.params["id"]!);
			if (result.outcome === "synced") {
				ctx.body = githubSyncResultSchema.parse({ head: result.head });
				return;
			}
			const { status, error } = errors[result.outcome];
			ctx.status = status;
			ctx.body = {
				error:
					result.outcome === "push-failed" && result.localUpdated
						? "github-sync-push-failed-local-updated"
						: error,
			};
		});
		return router;
	}
}
