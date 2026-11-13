import type { TicketHistory, TicketHistoryEvent } from "@forge/contracts/tickets";

/** Controlled history for mock development and browser state coverage. */
export function historyFixture(ticketId: string, currentStatus?: TicketHistoryEvent["status"]): TicketHistory {
	const events: TicketHistoryEvent[] = [];
	let visitId = 1;
	let status: TicketHistoryEvent["status"] = "backlog";
	const add = (
		type: TicketHistoryEvent["type"],
		outcome: TicketHistoryEvent["outcome"],
		revision?: number,
		reason?: string,
	) => {
		const id = events.length + 1;
		if (type === "status") visitId = id;
		events.push({
			id,
			ticketId,
			visitId,
			status,
			type,
			outcome,
			at: `2026-11-13T12:${String(id).padStart(2, "0")}:00.000Z`,
			...(revision && { revision }),
			...(reason && { reason }),
		});
	};
	add("status", "completed");
	status = "todo";
	add("status", "completed");
	status = "in-progress";
	add("status", "completed");
	add("planning", "working");
	add("plan-created", "completed", 1);
	add("awaiting-approval", "action-required");
	add("planning", "working");
	add("plan-adjusted", "completed", 2);
	add("awaiting-approval", "action-required");
	add("plan-approved", "completed", 2);
	add("implementing", "working");
	add("failure", "failed", undefined, "Agent turn failed. Review Chat and retry.");
	add("retry", "queued");
	add("implementing", "working");
	add("canceled", "canceled");
	status = "backlog";
	add("status", "completed");
	status = "todo";
	add("status", "completed");
	status = "in-progress";
	add("status", "completed");
	add("plan-approved", "completed", 2);
	add("implementing", "queued");
	if (currentStatus === "done") {
		add("implementing", "working");
		add("implemented", "completed");
		add("merge-queued", "queued");
		add("merged", "completed");
		status = "done";
		add("status", "completed");
	} else if (currentStatus && currentStatus !== status) {
		add("canceled", "canceled");
		status = currentStatus;
		add("status", "completed");
	}
	return { recordedFrom: events[0]!.at, bootstrapped: false, events };
}
