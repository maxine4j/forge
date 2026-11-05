import { terminalDimensionsSchema, terminalSessionSchema, terminalStatusSchema } from "@forge/contracts/terminal";
import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import { TerminalError } from "./errors.ts";
import type { ITerminalService } from "./terminal-service.ts";

export interface ITerminalRouter {
	create(): Router<{ actor: Actor }>;
}
export class TerminalRouter implements ITerminalRouter {
	constructor(private readonly terminals: ITerminalService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.use(async (ctx, next) => {
			try {
				await next();
			} catch (error) {
				if (!(error instanceof TerminalError)) throw error;
				ctx.status =
					error.code === "invalid-request"
						? 400
						: error.code === "terminal-not-found"
							? 404
							: error.code === "terminal-conflict"
								? 409
								: error.code === "terminal-capacity"
									? 429
									: 503;
				ctx.body = { error: error.code };
			}
		});
		router.post("/api/workspaces/:id/terminal", async (ctx) => {
			const data = terminalDimensionsSchema.safeParse(ctx.request.body);
			if (!data.success) throw new TerminalError("invalid-request");
			ctx.body = terminalSessionSchema.parse(
				await this.terminals.create(ctx.state.actor, ctx.params["id"] ?? "", data.data),
			);
			ctx.status = 201;
		});
		router.get("/api/workspaces/:id/terminal", async (ctx) => {
			ctx.body = terminalStatusSchema.parse({
				session: await this.terminals.status(ctx.state.actor, ctx.params["id"] ?? ""),
			});
		});
		router.get("/api/terminals/:id", async (ctx) => {
			ctx.body = terminalSessionSchema.parse(await this.terminals.get(ctx.state.actor, ctx.params["id"] ?? ""));
		});
		router.delete("/api/terminals/:id", async (ctx) => {
			ctx.body = terminalSessionSchema.parse(await this.terminals.close(ctx.state.actor, ctx.params["id"] ?? ""));
		});
		return router;
	}
}
