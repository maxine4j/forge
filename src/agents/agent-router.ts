import { PassThrough } from "node:stream";

import type { ISleep } from "@forge/backend-infrastructure/sleep";
import {
	agentMessageSchema,
	agentReplySchema,
	agentThreadsSchema,
	agentViewSchema,
	createAgentSchema,
	agentOptionsSchema,
	agentFilesSchema,
} from "@forge/contracts/agents";
import Router from "@koa/router";
import { z } from "zod";

import type { Actor } from "../auth/types.ts";
import type { IAgentService } from "./agent-service.ts";
import { AgentError } from "./errors.ts";
export class AgentRouter {
	private readonly streams = new Map<PassThrough, () => void>();
	private closed = false;
	constructor(
		private readonly service: IAgentService,
		private readonly sleep: ISleep,
	) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.use(async (ctx, next) => {
			try {
				await next();
			} catch (error) {
				if (!(error instanceof AgentError)) throw error;
				ctx.status =
					error.code === "invalid-request"
						? 400
						: error.code === "agent-not-found"
							? 404
							: error.code === "agent-conflict"
								? 409
								: 503;
				ctx.body = { error: error.code };
			}
		});
		router.get("/api/projects/:projectId/agents", async (ctx) => {
			ctx.body = agentThreadsSchema.parse(await this.service.list(ctx.state.actor, ctx.params["projectId"]!));
		});
		router.post("/api/projects/:projectId/agents", async (ctx) => {
			const input = createAgentSchema.safeParse(ctx.request.body);
			if (!input.success) throw new AgentError("invalid-request");
			ctx.body = agentViewSchema.parse(
				await this.service.create(ctx.state.actor, ctx.params["projectId"]!, input.data.title),
			);
			ctx.status = 201;
		});
		router.param("id", (id, _ctx, next) => {
			if (!z.uuid().safeParse(id).success) throw new AgentError("invalid-request");
			return next();
		});
		router.get("/api/agents/:id", async (ctx) => {
			ctx.body = agentViewSchema.parse(await this.service.get(ctx.state.actor, ctx.params["id"]!));
		});
		router.get("/api/agents/:id/options", async (ctx) => {
			ctx.body = agentOptionsSchema.parse(await this.service.options(ctx.state.actor, ctx.params["id"]!));
		});
		router.get("/api/agents/:id/files", async (ctx) => {
			const query = z
				.string()
				.max(500)
				.safeParse(ctx.query["query"] ?? "");
			if (!query.success) throw new AgentError("invalid-request");
			ctx.body = agentFilesSchema.parse(await this.service.files(ctx.state.actor, ctx.params["id"]!, query.data));
		});
		router.post("/api/agents/:id/messages", async (ctx) => {
			const input = agentMessageSchema.safeParse(ctx.request.body);
			if (!input.success) throw new AgentError("invalid-request");
			const { text, ...settings } = input.data;
			ctx.body = agentViewSchema.parse(
				await this.service.send(ctx.state.actor, ctx.params["id"]!, text, settings),
			);
		});
		router.post("/api/agents/:id/replies", async (ctx) => {
			const input = agentReplySchema.safeParse(ctx.request.body);
			if (!input.success) throw new AgentError("invalid-request");
			ctx.body = agentViewSchema.parse(await this.service.reply(ctx.state.actor, ctx.params["id"]!, input.data));
		});
		for (const operation of ["resume", "interrupt"] as const)
			router.post(`/api/agents/:id/${operation}`, async (ctx) => {
				ctx.body = agentViewSchema.parse(await this.service[operation](ctx.state.actor, ctx.params["id"]!));
			});
		router.get("/api/agents/:id/events", async (ctx) => {
			if (this.closed) throw new AgentError("agent-unavailable");
			const stream = new PassThrough();
			const lifetime = new AbortController();
			const send = (message: string) => {
				if (stream.writableLength > 65536) stream.destroy();
				else if (!stream.destroyed) stream.write(message);
			};
			const detach = await this.service.subscribe(ctx.state.actor, ctx.params["id"]!, () =>
				send("data: changed\n\n"),
			);
			const cleanup = () => {
				if (!this.streams.delete(stream)) return;
				lifetime.abort();
				detach();
				stream.destroy();
			};
			this.streams.set(stream, cleanup);
			ctx.res.once("close", cleanup);
			stream.once("close", cleanup);
			if (this.closed || ctx.res.destroyed) {
				cleanup();
				return;
			}
			ctx.type = "text/event-stream";
			ctx.set("x-accel-buffering", "no");
			ctx.body = stream;
			send("data: changed\n\n");
			void (async () => {
				try {
					while (!lifetime.signal.aborted) {
						await this.sleep(15000, lifetime.signal);
						send(": heartbeat\n\n");
					}
				} catch {
					cleanup();
				}
			})();
		});
		return router;
	}
	async close(): Promise<void> {
		this.closed = true;
		for (const cleanup of this.streams.values()) cleanup();
	}
}
