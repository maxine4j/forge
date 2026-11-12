import { costsSchema, ticketCostSchema } from "@forge/contracts";
import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import type { ICostService } from "./cost-service.ts";

export class CostRouter implements IHttpRouter {
	constructor(private readonly cost: ICostService) {}

	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.get("/api/costs", async (ctx) => {
			ctx.body = costsSchema.parse(await this.cost.read(ctx.state.actor));
		});
		router.get("/api/tickets/:id/cost", async (ctx) => {
			ctx.body = ticketCostSchema.parse(await this.cost.readTicket(ctx.state.actor, ctx.params["id"]!));
		});
		return router;
	}
}
