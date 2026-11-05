import { agentMessageSchema } from "@forge/contracts/agents";
import {
	createTicketSchema,
	moveTicketSchema,
	ticketSchema,
	ticketsSchema,
	ticketWorkflowSchema,
} from "@forge/contracts/tickets";
import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import { TicketError } from "./errors.ts";
import type { ITicketService } from "./ticket-service.ts";
import type { ITicketWorkflowService } from "./ticket-workflow-service.ts";

export class TicketRouter implements IHttpRouter {
	constructor(
		private readonly service: ITicketService,
		private readonly workflow: ITicketWorkflowService,
	) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.get("/api/tickets/:id/workflow", async (ctx) => {
			const ticket = await this.service.get(ctx.state.actor, ctx.params["id"]!);
			ctx.body = ticketWorkflowSchema.parse(await this.workflow.get(ctx.state.actor, ticket.id));
		});
		router.post("/api/tickets/:id/messages", async (ctx) => {
			const input = agentMessageSchema.safeParse(ctx.request.body);
			if (!input.success) throw new TicketError("invalid-request");
			const ticket = await this.service.get(ctx.state.actor, ctx.params["id"]!);
			ctx.body = ticketWorkflowSchema.parse(
				await this.workflow.message(ctx.state.actor, ticket, input.data.text),
			);
		});
		router.post("/api/tickets/:id/reconcile", async (ctx) => {
			const ticket = await this.service.get(ctx.state.actor, ctx.params["id"]!);
			await this.workflow.recover(ctx.state.actor, ticket.id);
			ctx.body = ticketWorkflowSchema.parse(await this.workflow.get(ctx.state.actor, ticket.id));
		});
		router.get("/api/projects/:projectId/tickets", async (ctx) => {
			ctx.body = ticketsSchema.parse(await this.service.list(ctx.state.actor, ctx.params["projectId"]!));
		});
		router.post("/api/projects/:projectId/tickets", async (ctx) => {
			const input = createTicketSchema.safeParse(ctx.request.body);
			if (!input.success) throw new TicketError("invalid-request");
			ctx.body = ticketSchema.parse(
				await this.service.create(ctx.state.actor, ctx.params["projectId"]!, input.data),
			);
			ctx.status = 201;
		});
		router.get("/api/tickets/:id", async (ctx) => {
			ctx.body = ticketSchema.parse(await this.service.get(ctx.state.actor, ctx.params["id"]!));
		});
		router.patch("/api/tickets/:id", async (ctx) => {
			const input = createTicketSchema.safeParse(ctx.request.body);
			if (!input.success) throw new TicketError("invalid-request");
			ctx.body = ticketSchema.parse(await this.service.update(ctx.state.actor, ctx.params["id"]!, input.data));
		});
		router.post("/api/tickets/:id/move", async (ctx) => {
			const input = moveTicketSchema.safeParse(ctx.request.body);
			if (!input.success) throw new TicketError("invalid-request");
			ctx.body = ticketSchema.parse(await this.service.move(ctx.state.actor, ctx.params["id"]!, input.data));
		});
		return router;
	}
}
