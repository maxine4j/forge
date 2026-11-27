import { boardSettingsUpdateSchema } from "@forge/contracts/tickets";
import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import type { IBoardSettingsService } from "./board-settings-service.ts";
import { TicketError } from "./errors.ts";

export class BoardSettingsRouter implements IHttpRouter {
	constructor(private readonly service: IBoardSettingsService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.get("/api/board/settings", (ctx) => {
			ctx.body = this.service.get(ctx.state.actor);
		});
		router.patch("/api/board/settings", async (ctx) => {
			const input = boardSettingsUpdateSchema.safeParse(ctx.request.body);
			if (!input.success) throw new TicketError("invalid-request");
			ctx.body = await this.service.update(ctx.state.actor, input.data);
		});
		router.post("/api/board/settings/stop", async (ctx) => {
			ctx.body = await this.service.stop(ctx.state.actor);
		});
		return router;
	}
}
