import { agentViewSchema } from "@forge/contracts/agents";
import {
	ticketWorkflowSchema,
	ticketNotificationsSchema,
	type TicketNotification,
	type Ticket,
} from "@forge/contracts/tickets";
import { useLayoutEffect, useRef, useState } from "react";

import { PlanMarkdown } from "../agents/agent-activity.tsx";
import { PlanReviewControls } from "../agents/plan-review-controls.tsx";
import { RequestCard } from "../agents/request-card.tsx";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { EpicIcon } from "./epic-icon.tsx";
import { TicketIndicator } from "./ticket-indicator.tsx";

const NotificationCard = ({
	item,
	api,
	drafts,
	refresh,
	open,
	openEpic,
}: {
	item: TicketNotification;
	api: IWorkspaceApi;
	drafts: Map<string, string>;
	refresh: () => void;
	open: (ticket: Ticket) => void;
	openEpic: (id: string) => void;
}) => {
	const [busy, setBusy] = useState(false);
	const locked = useRef(false);
	const [error, setError] = useState("");
	const draftKey = `notification-feedback:${item.id}`;
	const [feedback, setFeedback] = useState(() => drafts.get(draftKey) ?? "");
	const act = async (path: string, body: unknown, agent = false) => {
		if (locked.current) return;
		locked.current = true;
		setBusy(true);
		setError("");
		try {
			const current = await api.read("tickets/notifications", ticketNotificationsSchema);
			if (!current.some((value) => value.id === item.id)) return;
			if (agent) await api.read(path, agentViewSchema, "POST", body);
			else await api.read(path, ticketWorkflowSchema, "POST", body);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not submit. Retry.");
		} finally {
			refresh();
			locked.current = false;
			setBusy(false);
		}
	};
	return (
		<article className='notification-card' data-notification={item.id} tabIndex={-1}>
			<h3>
				<TicketIndicator ticket={item.ticket} />
				<button onClick={() => open(item.ticket)}>{item.ticket.title}</button>
			</h3>
			<nav aria-label='Ticket breadcrumb'>
				{item.epic && (
					<>
						<a
							href={`/tasks?view=notifications&epic=${item.epic.id}`}
							onClick={(event) => {
								event.preventDefault();
								openEpic(item.epic!.id);
							}}
						>
							<EpicIcon /> {item.epic.id} {item.epic.title}
						</a>
						<span> → </span>
					</>
				)}
				<a
					href={`/tasks?view=notifications&ticket=${item.ticket.id}`}
					onClick={(event) => {
						event.preventDefault();
						open(item.ticket);
					}}
				>
					<span
						className={`ticket-type ${item.ticket.status === "done" ? "ticket-complete" : ""}`}
						aria-hidden='true'
					>
						✓
					</span>{" "}
					{item.ticket.id}
				</a>
				<span> · {item.ticket.status}</span>
			</nav>
			<time dateTime={item.at}>{new Date(item.at).toLocaleString()}</time>
			{item.request && item.agentId && (
				<RequestCard
					request={item.request}
					drafts={drafts}
					busy={busy}
					reply={(input) => void act(`agents/${item.agentId}/replies`, input, true)}
				/>
			)}
			{item.kind === "plan" && item.workflow.plan && (
				<>
					<PlanMarkdown text={item.workflow.plan.text} />
					<PlanReviewControls
						busy={busy}
						approve={() =>
							void act(`tickets/${item.ticket.id}/approve`, { revision: item.workflow.plan!.revision })
						}
					/>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void act(`tickets/${item.ticket.id}/messages`, {
								text: feedback,
								revision: item.workflow.plan!.revision,
							});
						}}
					>
						<label>
							Plan feedback
							<textarea
								required
								maxLength={8000}
								disabled={busy}
								value={feedback}
								onChange={(event) => {
									setFeedback(event.target.value);
									drafts.set(draftKey, event.target.value);
								}}
							/>
						</label>
						<button disabled={busy || !feedback.trim()}>Submit feedback</button>
					</form>
				</>
			)}
			{item.message && <p>{item.message}</p>}
			{item.action && (
				<button disabled={busy} onClick={() => void act(`tickets/${item.ticket.id}/${item.action}`, {})}>
					{item.action === "merge"
						? "Queue merge"
						: item.workflow.state === "setup-failed"
							? "Retry setup"
							: item.workflow.state === "uncertain"
								? "Reconcile execution"
								: "Retry cleanup"}
				</button>
			)}
			<button onClick={() => open(item.ticket)}>Open ticket Chat</button>
			{error && <p role='alert'>{error}</p>}
		</article>
	);
};

export const TaskNotifications = ({
	items,
	loading,
	error,
	refresh,
	...props
}: {
	items: TicketNotification[];
	loading: boolean;
	error: string;
	refresh: () => void;
	api: IWorkspaceApi;
	drafts: Map<string, string>;
	open: (ticket: Ticket) => void;
	openEpic: (id: string) => void;
}) => {
	const root = useRef<HTMLDivElement>(null);
	const focused = useRef<{ id: string; index: number } | undefined>(undefined);
	useLayoutEffect(() => {
		const previous = focused.current;
		if (!previous || items.some((item) => item.id === previous.id)) return;
		const cards = root.current?.querySelectorAll<HTMLElement>("[data-notification]");
		(
			cards?.[Math.min(previous.index, cards.length - 1)] ?? root.current?.querySelector<HTMLElement>("h2")
		)?.focus();
		focused.current = undefined;
	}, [items]);
	return (
		<div
			ref={root}
			onBlurCapture={(event) => {
				if (event.relatedTarget && !root.current?.contains(event.relatedTarget as Node))
					focused.current = undefined;
			}}
			className='task-notifications'
			onFocusCapture={(event) => {
				const card = (event.target as HTMLElement).closest<HTMLElement>("[data-notification]");
				if (card)
					focused.current = {
						id: card.dataset["notification"]!,
						index: items.findIndex((item) => item.id === card.dataset["notification"]),
					};
			}}
		>
			{loading && <p role='status'>Loading notifications…</p>}
			{error && (
				<p role='alert'>
					{error} <button onClick={refresh}>Retry</button>
				</p>
			)}
			{!loading && !error && !items.length && <h2 tabIndex={-1}>No pending notifications</h2>}
			{items.map((item) => (
				<NotificationCard key={item.id} item={item} refresh={refresh} {...props} />
			))}
		</div>
	);
};
