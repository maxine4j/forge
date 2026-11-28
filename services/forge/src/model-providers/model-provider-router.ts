import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import type { IModelProviderService } from "./model-provider-service.ts";

export class ModelProviderRouter implements IHttpRouter {
	constructor(private readonly service: IModelProviderService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.get("/api/model-providers/relay-metrics", async (ctx) => {
			ctx.set("Cache-Control", "no-store");
			ctx.body = await this.service.relayMetrics(ctx.state.actor);
		});
		router.get("/api/model-providers/health", async (ctx) => {
			ctx.set("Cache-Control", "no-store");
			ctx.body = await this.service.health(ctx.state.actor);
		});
		router.get("/api/model-providers", async (ctx) => {
			ctx.body = await this.service.list(ctx.state.actor);
		});
		router.post("/api/model-providers", async (ctx) => {
			ctx.body = await this.service.create(ctx.state.actor, ctx.request.body);
			ctx.status = 201;
		});
		router.patch("/api/model-providers/:id", async (ctx) => {
			ctx.body = await this.service.update(ctx.state.actor, ctx.params["id"]!, ctx.request.body);
		});
		router.delete("/api/model-providers/:id", async (ctx) => {
			await this.service.remove(ctx.state.actor, ctx.params["id"]!);
			ctx.status = 204;
		});
		router.get("/api/model-providers/:id/model-options", async (ctx) => {
			ctx.body = await this.service.options(ctx.state.actor, ctx.params["id"]!);
		});
		return router;
	}
}
