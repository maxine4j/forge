import { projectCostSchema, projectIdSchema } from "@forge/contracts";
import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import { InvalidProjectError } from "../projects/errors.ts";
import type { ICostService } from "./cost-service.ts";

export class CostRouter implements IHttpRouter {
	constructor(private readonly cost: ICostService) {}

	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.get("/api/projects/:id/cost", async (ctx) => {
			const id = projectIdSchema.safeParse(ctx.params["id"]);
			if (!id.success) throw new InvalidProjectError();
			ctx.body = projectCostSchema.parse(await this.cost.read(ctx.state.actor, id.data));
		});
		return router;
	}
}
