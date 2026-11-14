import { ticketNotificationsSchema, ticketWorkflowSchema, type TicketNotification } from "@forge/contracts/tickets";

import type { IAgentThreadStore } from "../agents/agent-thread-store.ts";
import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { IEpicStore } from "../epics/epic-store.ts";
import { workflowNotificationKeys, type INotificationStore } from "./notification-store.ts";
import type { ITicketService } from "./ticket-service.ts";

export class NotificationService {
	constructor(
		private readonly store: INotificationStore,
		private readonly tickets: Pick<ITicketService, "list">,
		private readonly epics: Pick<IEpicStore, "list">,
		private readonly agents: Pick<IAgentThreadStore, "get">,
		private readonly access: IAccessService,
	) {}
	/** Bootstrap only first-observed metadata; never infer historical timestamps. */
	async initialize(): Promise<void> {
		for (const job of await this.store.workflows()) {
			await this.store.syncWorkflow(job);
			for (const id of [job.plannerId, job.implementerId]) {
				if (!id) continue;
				const agent = await this.agents.get(id);
				await this.store.sync(
					`agent:${id}`,
					agent?.managed && !agent.abandoned ? agent.requests.map((request) => request.id) : [],
				);
			}
		}
	}
	async list(actor: Actor): Promise<TicketNotification[]> {
		this.access.assertOwner(actor);
		const [tickets, epics, jobs, metadata] = await Promise.all([
			this.tickets.list(actor, false),
			this.epics.list(),
			this.store.workflows(),
			this.store.read(),
		]);
		const result: TicketNotification[] = [];
		for (const job of jobs) {
			const ticket = tickets.find((ticket) => ticket.id === job.ticketId);
			if (!ticket || ticket.archivedAt) continue;
			const epic = epics.find((epic) => epic.id === ticket.epicId);
			const workflow = ticketWorkflowSchema.strip().parse(job);
			const context = { ticket: { ...ticket, needsAttention: true as const }, epic, workflow };
			const keys = workflowNotificationKeys(job, ticket.status);
			for (const item of metadata.filter(
				(item) => item.source === `workflow:${ticket.id}` && keys.includes(item.condition),
			)) {
				const plan = item.condition.startsWith("plan:");
				const review = item.condition.startsWith("review:");
				const cleanup = item.condition.startsWith("cleanup:");
				result.push({
					...context,
					id: item.id,
					at: item.at,
					kind: plan ? "plan" : review ? "review" : "recovery",
					message: cleanup
						? (job.resetError ?? "Workspace cleanup failed.")
						: (job.message ?? (review ? "Implementation ready for review." : `Execution ${job.state}.`)),
					...(review || (job.state === "failed" && job.resultSha && ticket.status === "in-progress")
						? { action: "merge" as const }
						: cleanup || ["setup-failed", "uncertain"].includes(job.state)
							? { action: "reconcile" as const }
							: {}),
				});
			}
			const agentId = job.phase === "planning" ? job.plannerId : job.implementerId;
			if (!agentId || job.state !== "running") continue;
			const agent = await this.agents.get(agentId);
			if (!agent?.managed || agent.abandoned) continue;
			for (const request of agent.requests) {
				const item = metadata.find(
					(item) => item.source === `agent:${agentId}` && item.condition === request.id,
				);
				if (item) result.push({ ...context, id: item.id, at: item.at, kind: "request", agentId, request });
			}
		}
		return ticketNotificationsSchema.parse(
			result.sort((a, b) => a.at.localeCompare(b.at) || Number(a.id) - Number(b.id)),
		);
	}
}
