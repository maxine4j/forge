import { upstreamSyncResultSchema, upstreamSyncStatusSchema } from "@forge/contracts";
import Router from "@koa/router";
import { z } from "zod";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import { InvalidProjectError } from "../projects/errors.ts";
import type { IUpstreamSyncService } from "./upstream-sync-service.ts";

const emptyBody = z.union([z.undefined(), z.strictObject({})]);
const errors = {
	unconfigured: { status: 404, error: "upstream-sync-unconfigured" },
	unavailable: { status: 503, error: "upstream-sync-unavailable" },
	busy: { status: 409, error: "upstream-sync-busy" },
	conflict: { status: 409, error: "upstream-sync-conflict" },
	changed: { status: 409, error: "upstream-sync-changed" },
	"push-failed": { status: 502, error: "upstream-sync-push-failed" },
};

export class UpstreamSyncRouter implements IHttpRouter {
	constructor(private readonly sync: IUpstreamSyncService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>({ prefix: "/api/projects/:id/repository/upstream-sync" });
		router.get("/", async (ctx) => {
			ctx.body = upstreamSyncStatusSchema.parse(await this.sync.status(ctx.state.actor, ctx.params["id"]!));
		});
		router.post("/", async (ctx) => {
			if (!emptyBody.safeParse(ctx.request.body).success) throw new InvalidProjectError();
			const result = await this.sync.sync(ctx.state.actor, ctx.params["id"]!);
			if (result.outcome === "synced") {
				ctx.body = upstreamSyncResultSchema.parse({ head: result.head, branch: result.branch });
				return;
			}
			const { status, error } = errors[result.outcome];
			ctx.status = status;
			ctx.body = {
				error:
					result.outcome === "push-failed" && result.localUpdated
						? "upstream-sync-push-failed-local-updated"
						: error,
			};
		});
		return router;
	}
}
