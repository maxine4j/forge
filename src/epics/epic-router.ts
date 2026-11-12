import { editEpicSchema, epicDetailSchema, epicsSchema } from "@forge/contracts/tickets";
import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import type { IEpicService } from "./epic-service.ts";
import { EpicError } from "./errors.ts";

export class EpicRouter implements IHttpRouter {
	constructor(private readonly service: IEpicService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.get("/api/epics", async (ctx) => {
			ctx.body = epicsSchema.parse(await this.service.list(ctx.state.actor));
		});
		router.get("/api/epics/:id", async (ctx) => {
			ctx.body = epicDetailSchema.parse(await this.service.get(ctx.state.actor, ctx.params["id"]!));
		});
		router.post("/api/epics", async (ctx) => {
			const input = editEpicSchema.safeParse(ctx.request.body);
			if (!input.success) throw new EpicError("invalid-request");
			ctx.body = epicDetailSchema.parse(await this.service.create(ctx.state.actor, input.data));
			ctx.status = 201;
		});
		router.patch("/api/epics/:id", async (ctx) => {
			const input = editEpicSchema.safeParse(ctx.request.body);
			if (!input.success) throw new EpicError("invalid-request");
			ctx.body = epicDetailSchema.parse(
				await this.service.update(ctx.state.actor, ctx.params["id"]!, input.data),
			);
		});
		return router;
	}
}
