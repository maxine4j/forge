import { costRangeSchema, costsSchema, defaultCostRange, ticketCostSchema } from "@forge/contracts";
import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import { TicketError } from "../tickets/errors.ts";
import type { ICostService } from "./cost-service.ts";

export class CostRouter implements IHttpRouter {
	constructor(private readonly cost: ICostService) {}

	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.get("/api/costs", async (ctx) => {
			ctx.body = costsSchema.parse(await this.cost.read(ctx.state.actor, this.range(ctx.query["range"])));
		});
		router.get("/api/tickets/:id/cost", async (ctx) => {
			ctx.body = ticketCostSchema.parse(
				await this.cost.readTicket(ctx.state.actor, ctx.params["id"]!, this.range(ctx.query["range"])),
			);
		});
		return router;
	}

	private range(value: unknown): string {
		const range = costRangeSchema.safeParse(value ?? defaultCostRange);
		if (!range.success) throw new TicketError("invalid-request");
		return range.data;
	}
}
