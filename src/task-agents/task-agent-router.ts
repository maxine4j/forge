import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import type { ITaskAgents } from "./task-agent-service.ts";

export class TaskAgentRouter implements IHttpRouter {
	constructor(private readonly service: ITaskAgents) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.get("/api/task-agents", async (ctx) => {
			ctx.body = await this.service.list(ctx.state.actor);
		});
		router.post("/api/task-agents", async (ctx) => {
			ctx.body = await this.service.save(ctx.state.actor, ctx.request.body);
			ctx.status = 201;
		});
		router.patch("/api/task-agents/:id", async (ctx) => {
			ctx.body = await this.service.save(ctx.state.actor, ctx.request.body, ctx.params["id"]!);
		});
		router.delete("/api/task-agents/:id", async (ctx) => {
			await this.service.retire(ctx.state.actor, ctx.params["id"]!);
			ctx.status = 204;
		});
		return router;
	}
}
