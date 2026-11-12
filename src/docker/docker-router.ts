import { dockerIdSchema, dockerOperationSchema, dockerOverviewSchema } from "@forge/contracts/docker";
import Router, { type RouterMiddleware } from "@koa/router";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import { DockerError } from "./docker-command.ts";
import type { IDockerService } from "./docker-service.ts";

export class DockerRouter implements IHttpRouter {
	constructor(private readonly service: IDockerService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.get("/api/board/docker", async (ctx) => {
			ctx.body = dockerOverviewSchema.parse(await this.service.overview(ctx.state.actor));
		});
		router.get("/api/board/docker/operations/:id", (ctx) => {
			ctx.body = dockerOperationSchema.parse(this.service.operation(ctx.state.actor, ctx.params["id"]!));
		});
		const cleanup: RouterMiddleware<{ actor: Actor }> = (ctx) => {
			if (ctx.params["id"] !== undefined && !dockerIdSchema.safeParse(ctx.params["id"]).success)
				throw new DockerError("invalid-request");
			ctx.body = dockerOperationSchema.parse(this.service.cleanup(ctx.state.actor, ctx.params["id"]));
			ctx.status = 202;
		};
		router.post("/api/board/docker/cleanup", cleanup);
		router.post("/api/board/docker/containers/:id/cleanup", cleanup);
		return router;
	}
}
