import { createProjectSchema, projectIdSchema, projectSchema, projectsSchema } from "@forge/contracts";
import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import { InvalidProjectError } from "./errors.ts";
import type { IProjectService } from "./project-service.ts";

export interface IProjectRouter {
	create(): Router<{ actor: Actor }>;
}
export class ProjectRouter implements IProjectRouter {
	constructor(private readonly projects: IProjectService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>({ prefix: "/api/projects" });
		router.get("/", async (ctx) => {
			ctx.body = projectsSchema.parse(await this.projects.list(ctx.state.actor));
		});
		router.post("/", async (ctx) => {
			const input = createProjectSchema.safeParse(ctx.request.body);
			if (!input.success) throw new InvalidProjectError();
			ctx.body = projectSchema.parse(await this.projects.create(ctx.state.actor, input.data));
			ctx.status = 201;
		});
		router.get("/:id", async (ctx) => {
			ctx.body = projectSchema.parse(await this.projects.get(ctx.state.actor, this.parseId(ctx.params["id"])));
		});
		router.post("/:id/retry", async (ctx) => {
			ctx.body = projectSchema.parse(await this.projects.retry(ctx.state.actor, this.parseId(ctx.params["id"])));
		});
		return router;
	}
	private parseId(value: unknown): string {
		const result = projectIdSchema.safeParse(value);
		if (!result.success) throw new InvalidProjectError();
		return result.data;
	}
}
