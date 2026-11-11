import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import type { ISettingsService } from "./settings-service.ts";

export class SettingsRouter implements IHttpRouter {
	constructor(private readonly service: ISettingsService) {}

	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.get("/api/settings", (ctx) => {
			ctx.body = this.service.get(ctx.state.actor);
		});
		router.put("/api/settings", async (ctx) => {
			ctx.body = await this.service.save(ctx.state.actor, ctx.request.body);
		});
		return router;
	}
}
