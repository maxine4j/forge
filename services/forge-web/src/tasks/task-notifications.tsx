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
import { ticketLabels } from "./ticket-labels.ts";

const relativeTime = new Intl.RelativeTimeFormat("en");
const formatNotificationAge = (date: Date) => {
	const minutes = Math.floor((Date.now() - date.getTime()) / 60_000);
	if (minutes < 1) return "Just now";
	if (minutes < 60) return relativeTime.format(-minutes, "minute");
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return relativeTime.format(-hours, "hour");
	return relativeTime.format(-Math.floor(hours / 24), "day");
};

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
	const date = new Date(item.at);
	const plan = item.kind === "plan" ? item.workflow.plan : undefined;
	const archive = async () => {
		if (locked.current) return;
		locked.current = true;
		setBusy(true);
		setError("");
		try {
			await api.read(`tickets/notifications/${item.id}/archive`, { parse: () => undefined }, "POST");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not archive notification. Retry.");
		} finally {
			refresh();
			locked.current = false;
			setBusy(false);
		}
	};
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
			<div className='notification-header'>
				<button
					type='button'
					className='notification-archive task-agent-archive'
					aria-label='Archive notification'
					title='Archive notification'
					disabled={busy}
					onClick={() => void archive()}
				>
					<svg
						width='16'
						height='16'
						viewBox='0 0 24 24'
						fill='none'
						stroke='currentColor'
						strokeWidth='2'
						strokeLinecap='round'
						strokeLinejoin='round'
						aria-hidden='true'
					>
						<rect x='3' y='3' width='18' height='5' rx='1' />
						<path d='M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8m-9 4h4' />
					</svg>
				</button>
				<div className='ticket-details-heading'>
					<nav className='ticket-details-key-row' aria-label='Ticket breadcrumb'>
						{item.epic && (
							<>
								<a
									className='ticket-epic-link'
									href={`/tasks?view=notifications&epic=${item.epic.id}`}
									aria-label={`${item.epic.id} ${item.epic.title}`}
									title={item.epic.title}
									onClick={(event) => {
										event.preventDefault();
										openEpic(item.epic!.id);
									}}
								>
									<EpicIcon /> <span>{item.epic.id}</span>
								</a>
								<span className='ticket-breadcrumb-divider' aria-hidden='true'>
									/
								</span>
							</>
						)}
						<a
							className='notification-ticket-link'
							href={`/tasks?view=notifications&ticket=${item.ticket.id}&tab=chat`}
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
							</span>
							{item.ticket.id}
						</a>
						<span className={`ticket-status-pill ticket-status-${item.ticket.status}`}>
							{ticketLabels[item.ticket.status]}
						</span>
					</nav>
					<time dateTime={item.at} title={date.toLocaleString()}>
						{formatNotificationAge(date)}
					</time>
				</div>
				<div className='notification-title'>
					<h3>{item.ticket.title}</h3>
					<TicketIndicator ticket={item.ticket} />
				</div>
			</div>
			{item.request && item.agentId && (
				<RequestCard
					request={item.request}
					drafts={drafts}
					busy={busy}
					reply={(input) => void act(`agents/${item.agentId}/replies`, input, true)}
				/>
			)}
			{plan && (
				<>
					<div className='notification-plan'>
						<PlanMarkdown text={plan.text} />
					</div>
					<form
						className='notification-feedback'
						onSubmit={(event) => {
							event.preventDefault();
							void act(`tickets/${item.ticket.id}/messages`, {
								text: feedback,
								revision: plan.revision,
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
						<div className='agent-actions notification-actions'>
							<button type='submit' disabled={busy || !feedback.trim()}>
								Submit feedback
							</button>
							<PlanReviewControls
								busy={busy}
								approve={() =>
									void act(`tickets/${item.ticket.id}/approve`, { revision: plan.revision })
								}
							/>
						</div>
					</form>
				</>
			)}
			{item.message && <p>{item.message}</p>}
			{item.action && (
				<div className='agent-actions notification-actions'>
					<button disabled={busy} onClick={() => void act(`tickets/${item.ticket.id}/${item.action}`, {})}>
						{item.action === "merge"
							? "Queue merge"
							: item.workflow.state === "setup-failed"
								? "Retry setup"
								: item.workflow.state === "uncertain"
									? "Reconcile execution"
									: "Retry cleanup"}
					</button>
				</div>
			)}
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
