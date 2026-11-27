import type { TicketHistoryEvent } from "@forge/contracts/tickets";
import { expect, test } from "vitest";

import { historyVisits } from "./ticket-history.tsx";

const status: TicketHistoryEvent = {
	id: 1,
	visitId: 1,
	ticketId: "TASK-1",
	at: "2026-11-13T12:00:00.000Z",
	status: "in-progress",
	type: "status",
	outcome: "completed",
};
const step = (
	id: number,
	type: TicketHistoryEvent["type"],
	outcome: TicketHistoryEvent["outcome"],
): TicketHistoryEvent => ({ ...status, id, type, outcome });

test("a resumed bootstrapped execution shows active work without inventing earlier milestones", () => {
	const visits = historyVisits([status, step(2, "recovery", "action-required"), step(3, "resumed", "working")]);
	expect(visits[0]?.status.outcome).toBe("working");
	expect(visits[0]?.steps).toMatchObject([
		{ type: "recovery", outcome: "completed" },
		{ type: "resumed", outcome: "working" },
	]);
});

test("resuming a known phase keeps completed plans green and only the active phase working", () => {
	const events = [
		status,
		step(2, "plan-created", "completed"),
		step(3, "implementing", "working"),
		step(4, "action-required", "action-required"),
		step(5, "resumed", "working"),
	];
	const visits = historyVisits(events);
	expect(visits[0]?.steps.filter((event) => event.outcome === "working")).toMatchObject([{ type: "implementing" }]);
	expect(visits[0]?.steps[0]?.outcome).toBe("completed");
	expect(events[3]?.outcome).toBe("action-required");
});
