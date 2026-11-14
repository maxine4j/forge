import { agentOptionsSchema } from "@forge/contracts/agents";
import { ticketExecutionSettingsSchema } from "@forge/contracts/tickets";
import {
	createTicketSchema,
	updateTicketSchema,
	ticketMessageSchema,
	approveTicketPlanSchema,
	moveTicketSchema,
	ticketSchema,
	ticketsSchema,
	ticketWorkflowSchema,
	ticketHistoryQuerySchema,
	ticketHistorySchema,
} from "@forge/contracts/tickets";
import { ticketNotificationsSchema } from "@forge/contracts/tickets";
import Router from "@koa/router";

import type { Actor } from "../auth/types.ts";
import type { IHttpRouter } from "../http/http-application.ts";
import { TicketError } from "./errors.ts";
import type { NotificationService } from "./notification-service.ts";
import type { TicketHistoryStore } from "./ticket-history-store.ts";
import type { ITicketService } from "./ticket-service.ts";
import type { ITicketWorkflowService } from "./ticket-workflow-service.ts";

export class TicketRouter implements IHttpRouter {
	constructor(
		private readonly service: ITicketService,
		private readonly workflow: ITicketWorkflowService,
		private readonly history: Pick<TicketHistoryStore, "read">,
		private readonly notifications?: NotificationService,
	) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>();
		router.get("/api/tickets/notifications", async (ctx) => {
			if (!this.notifications) throw new TicketError("ticket-unavailable");
			ctx.body = ticketNotificationsSchema.parse(await this.notifications.list(ctx.state.actor));
		});
		router.get("/api/tickets/:id/history", async (ctx) => {
			const ticket = await this.service.get(ctx.state.actor, ctx.params["id"]!);
			const query = ticketHistoryQuerySchema.safeParse(ctx.query);
			if (!query.success) throw new TicketError("invalid-request");
			ctx.body = ticketHistorySchema.parse(await this.history.read(ticket.id, query.data.after));
		});
		router.post("/api/tickets/:id/clear-plan", async (ctx) => {
			const ticket = await this.service.get(ctx.state.actor, ctx.params["id"]!);
			ctx.body = ticketWorkflowSchema.parse(await this.workflow.clearPlan(ctx.state.actor, ticket));
		});
		router.get("/api/tickets/:id/model-options", async (ctx) => {
			await this.service.get(ctx.state.actor, ctx.params["id"]!);
			ctx.body = agentOptionsSchema.parse(await this.workflow.options(ctx.state.actor, ctx.params["id"]!));
		});
		router.patch("/api/tickets/:id/settings", async (ctx) => {
			const settings = ticketExecutionSettingsSchema.safeParse(ctx.request.body);
			if (!settings.success) throw new TicketError("invalid-request");
			const ticket = await this.service.get(ctx.state.actor, ctx.params["id"]!);
			await this.workflow.settings(ctx.state.actor, ticket, settings.data);
			ctx.body = ticketSchema.parse(await this.service.get(ctx.state.actor, ticket.id));
		});
		router.get("/api/tickets/:id/workflow", async (ctx) => {
			const ticket = await this.service.get(ctx.state.actor, ctx.params["id"]!);
			ctx.body = ticketWorkflowSchema.parse(await this.workflow.get(ctx.state.actor, ticket.id));
		});
		router.post("/api/tickets/:id/messages", async (ctx) => {
			const input = ticketMessageSchema.safeParse(ctx.request.body);
			if (!input.success) throw new TicketError("invalid-request");
			const ticket = await this.service.get(ctx.state.actor, ctx.params["id"]!);
			ctx.body = ticketWorkflowSchema.parse(
				await this.workflow.message(
					ctx.state.actor,
					ticket,
					input.data.text,
					input.data.expectedTurnId,
					input.data.revision,
				),
			);
		});
		router.post("/api/tickets/:id/approve", async (ctx) => {
			const input = approveTicketPlanSchema.safeParse(ctx.request.body);
			if (!input.success) throw new TicketError("invalid-request");
			const ticket = await this.service.get(ctx.state.actor, ctx.params["id"]!);
			ctx.body = ticketWorkflowSchema.parse(
				await this.workflow.approve(ctx.state.actor, ticket, input.data.revision),
			);
		});
		router.post("/api/tickets/:id/merge", async (ctx) => {
			const ticket = await this.service.get(ctx.state.actor, ctx.params["id"]!);
			ctx.body = ticketWorkflowSchema.parse(await this.workflow.queueMerge(ctx.state.actor, ticket));
		});
		router.post("/api/tickets/:id/reconcile", async (ctx) => {
			const ticket = await this.service.get(ctx.state.actor, ctx.params["id"]!);
			await this.workflow.recover(ctx.state.actor, ticket.id);
			ctx.body = ticketWorkflowSchema.parse(await this.workflow.get(ctx.state.actor, ticket.id));
		});
		router.get("/api/tickets", async (ctx) => {
			const includeArchived = ctx.query["includeArchived"];
			if (includeArchived !== undefined && includeArchived !== "true" && includeArchived !== "false")
				throw new TicketError("invalid-request");
			ctx.body = ticketsSchema.parse(await this.service.list(ctx.state.actor, includeArchived === "true"));
		});
		router.post("/api/tickets", async (ctx) => {
			const input = createTicketSchema.safeParse(ctx.request.body);
			if (!input.success) throw new TicketError("invalid-request");
			ctx.body = ticketSchema.parse(await this.service.create(ctx.state.actor, input.data));
			ctx.status = 201;
		});
		router.get("/api/tickets/:id", async (ctx) => {
			ctx.body = ticketSchema.parse(await this.service.get(ctx.state.actor, ctx.params["id"]!));
		});
		router.patch("/api/tickets/:id", async (ctx) => {
			const input = updateTicketSchema.safeParse(ctx.request.body);
			if (!input.success) throw new TicketError("invalid-request");
			ctx.body = ticketSchema.parse(await this.service.update(ctx.state.actor, ctx.params["id"]!, input.data));
		});
		router.post("/api/tickets/:id/archive", async (ctx) => {
			ctx.body = ticketSchema.parse(await this.service.archive(ctx.state.actor, ctx.params["id"]!));
		});
		router.post("/api/tickets/:id/move", async (ctx) => {
			const input = moveTicketSchema.safeParse(ctx.request.body);
			if (!input.success) throw new TicketError("invalid-request");
			ctx.body = ticketSchema.parse(await this.service.move(ctx.state.actor, ctx.params["id"]!, input.data));
		});
		return router;
	}
}
