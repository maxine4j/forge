import { ticketHistorySchema, type TicketHistoryEvent, type TicketHistory } from "@forge/contracts/tickets";
import { useEffect, useRef, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { useToast } from "../toasts/toasts.tsx";

const labels: Record<TicketHistoryEvent["type"], string> = {
	status: "Status",
	planning: "Planning",
	"plan-created": "Plan created",
	"plan-adjusted": "Plan adjusted",
	"awaiting-approval": "Awaiting plan approval",
	"plan-approved": "Plan approved",
	implementing: "Implementing",
	implemented: "Implemented",
	"merge-queued": "Queued to merge",
	rebasing: "Rebasing",
	merged: "Merged",
	retry: "Retry queued",
	"action-required": "Action required in Chat",
	resumed: "Work resumed",
	failure: "Failed",
	canceled: "Canceled",
	cleanup: "Cleanup",
	recovery: "Reconcile execution in Chat",
};
const statuses = { backlog: "Backlog", todo: "Ready for development", "in-progress": "In progress", done: "Done" };
const outcomes = {
	completed: "Completed",
	working: "Actively working",
	failed: "Failed",
	"action-required": "Action required",
	queued: "Queued",
	canceled: "Canceled",
};

/** Resolve only unfinished milestones; terminal failures survive later retries. */
export function historyVisits(events: TicketHistoryEvent[]) {
	const visits: { status: TicketHistoryEvent; steps: TicketHistoryEvent[] }[] = [];
	for (const event of events) {
		if (event.type === "status") {
			const previous = visits.at(-1);
			if (previous) {
				for (const step of previous.steps) {
					if (["working", "queued", "action-required"].includes(step.outcome))
						step.outcome =
							event.status === "done"
							|| (previous.status.status === "todo" && event.status === "in-progress")
								? "completed"
								: "canceled";
				}
			}
			visits.push({ status: event, steps: [] });
			continue;
		}
		const visit = visits.find((value) => value.status.id === event.visitId);
		if (!visit) continue;
		if (event.outcome === "working") {
			for (const step of visit.steps) {
				if (
					(step.type === "retry" && step.outcome === "queued")
					|| (step.type === "awaiting-approval"
						&& step.outcome === "action-required"
						&& event.type === "planning")
				)
					step.outcome = "completed";
			}
		}
		const queued = visit.steps.findLast((step) => step.type === event.type && step.outcome === "queued");
		if (queued && event.outcome === "working") {
			Object.assign(queued, { outcome: "working", at: event.at });
			for (const step of visit.steps)
				if (step.type === "retry" && step.outcome === "queued") step.outcome = "completed";
			continue;
		}
		for (const step of visit.steps) {
			if (!["working", "queued", "action-required"].includes(step.outcome)) continue;
			if (["failure", "canceled"].includes(event.type)) step.outcome = event.outcome;
			else if (event.type === "action-required" || event.type === "recovery") step.outcome = "action-required";
			else if (event.type === "resumed")
				step.outcome = ["planning", "implementing", "rebasing"].includes(step.type) ? "working" : "completed";
			else if (
				["plan-created", "plan-adjusted", "plan-approved", "implemented", "merged"].includes(event.type)
				|| (event.type === "cleanup" && event.outcome === "completed")
				|| event.type === "rebasing"
			)
				step.outcome = "completed";
		}
		const resumedPhase = visit.steps.some(
			(step) => ["planning", "implementing", "rebasing"].includes(step.type) && step.outcome === "working",
		);
		visit.steps.push({
			...event,
			...(event.type === "resumed" && resumedPhase && { outcome: "completed" as const }),
		});
	}
	const current = visits.at(-1);
	if (current && ["todo", "in-progress"].includes(current.status.status)) {
		const pending = current.steps.findLast((step) =>
			["working", "queued", "action-required"].includes(step.outcome),
		);
		current.status = {
			...current.status,
			outcome:
				pending?.outcome
				?? current.steps.at(-1)?.outcome
				?? (current.status.status === "todo" ? "queued" : "completed"),
		};
	}
	return visits;
}

const HistoryNode = ({ event, status = false }: { event: TicketHistoryEvent; status?: boolean }) => (
	<div className={`history-entry history-${event.outcome}`}>
		<span className='history-node' aria-label={outcomes[event.outcome]}>
			<svg viewBox='0 0 24 24' aria-hidden='true'>
				{event.outcome === "completed" ? (
					<path d='m5 12 4 4L19 6' />
				) : event.outcome === "working" ? (
					<path className='history-spinner' d='M12 3a9 9 0 1 1-9 9' />
				) : event.outcome === "failed" ? (
					<path d='M12 5v9m0 3v1' />
				) : event.outcome === "action-required" ? (
					<circle cx='12' cy='12' r='5' fill='currentColor' />
				) : event.outcome === "queued" ? (
					<>
						<circle cx='12' cy='12' r='9' />
						<path d='M12 6v6l4 2' />
					</>
				) : (
					<path d='M6 6h12v12H6z' />
				)}
			</svg>
		</span>
		<div>
			{status ? (
				<h3>{statuses[event.status]}</h3>
			) : (
				<strong>
					{labels[event.type]}
					{event.revision ? ` · Revision ${event.revision}` : ""}
				</strong>
			)}
			<span className='history-state'>{outcomes[event.outcome]}</span>
			<time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
			{event.reason && <p>{event.reason}</p>}
		</div>
	</div>
);

export const TicketHistoryTimeline = ({
	api,
	ticketId,
	selected,
}: {
	api: IWorkspaceApi;
	ticketId: string;
	selected: boolean;
}) => {
	const [data, setData] = useState<TicketHistory>();
	const [events, setEvents] = useState<TicketHistoryEvent[]>([]);
	const [error, setError] = useState(false);
	const { notify } = useToast();
	const [retry, setRetry] = useState(0);
	const [loadingMore, setLoadingMore] = useState(false);
	const cursor = useRef(0);
	const busy = useRef(false);
	const [page, setPage] = useState(0);
	useEffect(() => {
		if (!selected) return;
		let active = true;
		let timer: ReturnType<typeof setTimeout>;
		const load = async () => {
			if (busy.current) {
				timer = setTimeout(() => void load(), 1000);
				return;
			}
			busy.current = true;
			try {
				const result = await api.read(
					`tickets/${ticketId}/history?after=${cursor.current}`,
					ticketHistorySchema,
				);
				if (!active) return;
				setData(result);
				setError(false);
				setEvents((old) => [...new Map([...old, ...result.events].map((event) => [event.id, event])).values()]);
				// Stop at page boundaries until the reader explicitly loads more.
				if (!result.nextCursor) cursor.current = result.events.at(-1)?.id ?? cursor.current;
			} catch {
				if (active) {
					setError(true);
					notify("History is unavailable.");
				}
			} finally {
				busy.current = false;
				if (active) {
					setLoadingMore(false);
					timer = setTimeout(() => void load(), 1000);
				}
			}
		};
		void load();
		return () => {
			active = false;
			clearTimeout(timer);
		};
	}, [api, ticketId, selected, retry, page, notify]);
	return (
		<div className='ticket-history'>
			{!data && !error && <p role='status'>Loading history…</p>}
			{error && (
				<div>
					<button onClick={() => setRetry((value) => value + 1)}>Retry</button>
				</div>
			)}
			{data && (
				<>
					<p className='history-recorded'>
						History recorded from {new Date(data.recordedFrom).toLocaleString()}
						{data.bootstrapped ? ". Earlier transitions are unknown." : "."}
					</p>
					{events.length === 0 && <p>No history recorded.</p>}
					<ol className='history-visits' aria-label='Ticket history'>
						{historyVisits(events).map((visit) => (
							<li key={visit.status.id}>
								<HistoryNode event={visit.status} status />
								{visit.steps.length > 0 && (
									<ol
										className='history-steps'
										aria-label={`${statuses[visit.status.status]} milestones`}
									>
										{visit.steps.map((step) => (
											<li key={step.id}>
												<HistoryNode event={step} />
											</li>
										))}
									</ol>
								)}
							</li>
						))}
					</ol>
					{data.nextCursor && (
						<button
							disabled={loadingMore}
							onClick={() => {
								cursor.current = data.nextCursor!;
								setLoadingMore(true);
								setPage((value) => value + 1);
							}}
						>
							Load more history
						</button>
					)}
				</>
			)}
		</div>
	);
};
