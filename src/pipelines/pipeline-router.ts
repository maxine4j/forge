import {
	pipelineInputSchema,
	pipelineRunSchema,
	pipelineDiscoverySchema,
	pipelineHistorySchema,
} from "@forge/contracts/pipelines";
import Router from "@koa/router";
import { z } from "zod";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import { PipelineError } from "./errors.ts";
import type { IPipelineService } from "./pipeline-service.ts";

export class PipelineRouter implements IHttpRouter {
	constructor(private readonly service: IPipelineService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>({ prefix: "/api/projects/:id" });
		router.use(async (ctx, next) => {
			try {
				await next();
			} catch (error) {
				if (!(error instanceof PipelineError)) throw error;
				ctx.status =
					error.code === "pipeline-invalid"
						? 400
						: error.code === "pipeline-busy"
							? 409
							: error.code === "pipeline-not-found"
								? 404
								: 503;
				ctx.body = { error: error.code, ...(error.detail ? { message: error.detail } : {}) };
			}
		});
		router.get("/pipelines", async (ctx) => {
			ctx.body = pipelineDiscoverySchema.parse(
				await this.service.discover(
					ctx.state.actor,
					ctx.params["id"]!,
					typeof ctx.query["branch"] === "string" ? ctx.query["branch"] : "main",
				),
			);
		});
		router.post("/pipeline-runs", async (ctx) => {
			const input = pipelineInputSchema.safeParse(ctx.request.body);
			if (!input.success)
				throw new PipelineError("pipeline-invalid", "Select a valid branch, workflow and event.");
			ctx.body = pipelineRunSchema.parse(
				await this.service.submit(ctx.state.actor, ctx.params["id"]!, input.data),
			);
			ctx.status = 202;
		});
		router.get("/pipeline-runs", async (ctx) => {
			const offset = z.coerce
				.number()
				.int()
				.min(0)
				.max(100000)
				.safeParse(ctx.query["offset"] ?? 0);
			if (!offset.success) throw new PipelineError("pipeline-invalid");
			ctx.body = pipelineHistorySchema.parse(
				await this.service.history(ctx.state.actor, ctx.params["id"]!, offset.data),
			);
		});
		router.get("/pipeline-runs/:runId", async (ctx) => {
			ctx.body = pipelineRunSchema.parse(
				await this.service.get(ctx.state.actor, ctx.params["id"]!, ctx.params["runId"]!),
			);
		});
		return router;
	}
}
