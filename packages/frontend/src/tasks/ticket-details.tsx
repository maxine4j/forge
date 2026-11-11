import {
	ticketWorkflowSchema,
	type Ticket,
	type TicketStatus,
	type CreateTicket,
	type MoveTicket,
	type TicketWorkflow,
} from "@forge/contracts/tickets";
import { lazy, Suspense, useEffect, useRef, useState, useId } from "react";

import { Conversation } from "../agents/agent-chat.tsx";
import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";

const Markdown = lazy(() => import("react-markdown"));
const tabLabels = { details: "Details", plan: "Plan", chat: "Chat", history: "Planning history" };
type TicketTab = keyof typeof tabLabels;

export const ticketLabels: Record<TicketStatus, string> = {
	backlog: "Backlog",
	todo: "Ready for development",
	"in-progress": "In progress",
	done: "Done",
};

export const TicketDetails = ({
	ticket,
	api,
	busy,
	close,
	archive,
	save,
	move,
	refreshBoard,
	drafts,
}: {
	ticket: Ticket;
	api: IWorkspaceApi;
	busy: boolean;
	close: () => void;
	archive: () => Promise<void>;
	save: (input: CreateTicket) => Promise<void>;
	move: (id: string, input: MoveTicket) => Promise<void>;
	refreshBoard: () => void;
	drafts: Map<string, string>;
}) => {
	const dialog = useRef<HTMLDialogElement>(null);
	const archiveDialog = useRef<HTMLDialogElement>(null);
	const fieldId = useId();
	const poller = useRef<ResourcePoller<TicketWorkflow> | undefined>(undefined);
	const [job, setJob] = useState<TicketWorkflow>();
	const [section, setTab] = useState<TicketTab>();
	const [acting, setActing] = useState(false);
	const [title, setTitle] = useState(ticket.title);
	const [description, setDescription] = useState(ticket.description);
	const [error, setError] = useState("");
	const [archiveError, setArchiveError] = useState("");
	const [refresh] = useState(() => () => poller.current?.refresh());
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	useEffect(() => {
		const resource = new ResourcePoller(
			() => api.read(`tickets/${ticket.id}/workflow`, ticketWorkflowSchema),
			(value) => {
				setJob(value);
				setError("");
			},
			setError,
			1000,
		);
		poller.current = resource;
		resource.refresh();
		return () => {
			resource.stop();
			poller.current = undefined;
		};
	}, [api, ticket.id]);
	const currentId = job?.phase === "planning" ? job.plannerId : job?.implementerId;
	const plan = job?.plan;
	const hasHistory = !!job?.implementerId && !!job.plannerId;
	const awaitingReview =
		ticket.status === "in-progress" && job?.phase === "planning" && job.state === "idle" && !!plan;
	const tabs: TicketTab[] = ["details"];
	if (plan) tabs.push("plan");
	tabs.push("chat");
	if (hasHistory) tabs.push("history");
	const tab = section && tabs.includes(section) ? section : awaitingReview ? "plan" : currentId ? "chat" : "details";
	const selectTab = (next: TicketTab) => {
		setTab(next);
		document.getElementById(`${fieldId}-tab-${next}`)?.focus();
	};
	const panel = (name: TicketTab) => ({
		id: `${fieldId}-panel-${name}`,
		role: "tabpanel",
		"aria-labelledby": `${fieldId}-tab-${name}`,
		hidden: tab !== name,
		tabIndex: 0,
	});
	const blocked = !job || !["idle", "failed"].includes(job.state) || ticket.status !== "in-progress";
	const target = ticket.status === "backlog" ? "todo" : undefined;
	const canQueueMerge =
		ticket.status === "in-progress"
		&& job?.resultSha
		&& ((job.phase === "review" && job.state === "idle") || job.state === "failed");
	const act = (path: string, body: unknown, onSuccess?: () => void) => {
		if (acting || !poller.current) return;
		setActing(true);
		setError("");
		void poller.current
			.mutate(async () => {
				const updated = await api.read(`tickets/${ticket.id}/${path}`, ticketWorkflowSchema, "POST", body);
				onSuccess?.();
				refreshBoard();
				return updated;
			})
			.finally(() => setActing(false));
	};
	return (
		<dialog
			ref={dialog}
			className='ticket-details ticket-dialog'
			aria-labelledby='ticket-details-title'
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) close();
			}}
		>
			<div className='ticket-details-heading'>
				<div>
					<h2 id='ticket-details-title'>{ticket.id}</h2>
					<p>{ticket.title}</p>
				</div>
				<div className='ticket-details-actions'>
					<button
						type='button'
						aria-label='Archive ticket'
						title='Archive ticket'
						disabled={busy || acting}
						onClick={() => {
							setArchiveError("");
							archiveDialog.current?.showModal();
						}}
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
					<button type='button' aria-label='Close ticket' disabled={busy} onClick={close}>
						✕
					</button>
				</div>
			</div>
			<dialog
				ref={archiveDialog}
				className='ticket-dialog ticket-archive-dialog'
				aria-labelledby={`${fieldId}-archive-title`}
				aria-describedby={`${fieldId}-archive-description`}
				onCancel={(event) => {
					event.stopPropagation();
					event.preventDefault();
					if (!busy) archiveDialog.current?.close();
				}}
			>
				<h2 id={`${fieldId}-archive-title`}>Archive {ticket.id}?</h2>
				<p id={`${fieldId}-archive-description`}>
					This removes the ticket from the task board and keeps its details and history.
				</p>
				{archiveError && (
					<p role='alert' className='error'>
						{archiveError}
					</p>
				)}
				<div className='ticket-dialog-actions'>
					<button type='button' disabled={busy} onClick={() => archiveDialog.current?.close()}>
						Cancel
					</button>
					<button
						type='button'
						className='primary'
						disabled={busy}
						onClick={() => {
							setArchiveError("");
							void archive().catch((err: unknown) =>
								setArchiveError(err instanceof Error ? err.message : "Cannot archive ticket."),
							);
						}}
					>
						{busy ? "Archiving…" : "Archive"}
					</button>
				</div>
			</dialog>
			<div className='ticket-details-toolbar'>
				<label>
					Status
					<select
						aria-label='Status'
						value={ticket.status}
						disabled={busy || !target}
						onChange={(event) => {
							setError("");
							void move(ticket.id, { status: event.target.value as TicketStatus }).catch((err: unknown) =>
								setError(err instanceof Error ? err.message : "Cannot move ticket."),
							);
						}}
					>
						<option value={ticket.status}>{ticketLabels[ticket.status]}</option>
						{target && <option value={target}>{ticketLabels[target]}</option>}
					</select>
				</label>
				<span role='status'>
					{awaitingReview
						? "Plan ready for review"
						: job?.state === "merge-queued"
							? "Queued to merge"
							: (job?.state ?? "Loading")}
				</span>
			</div>
			<div role='tablist' aria-label='Ticket sections' className='ticket-details-tabs'>
				{tabs.map((name, index) => (
					<button
						key={name}
						type='button'
						role='tab'
						id={`${fieldId}-tab-${name}`}
						aria-controls={`${fieldId}-panel-${name}`}
						aria-selected={tab === name}
						tabIndex={tab === name ? 0 : -1}
						onClick={() => setTab(name)}
						onKeyDown={(event) => {
							const adjacent = {
								ArrowLeft: index - 1,
								ArrowRight: index + 1,
								Home: 0,
								End: tabs.length - 1,
							};
							const next = adjacent[event.key as keyof typeof adjacent];
							if (typeof next !== "number") return;
							event.preventDefault();
							selectTab(tabs.at((next + tabs.length) % tabs.length)!);
						}}
					>
						{tabLabels[name]}
					</button>
				))}
			</div>
			{error && (
				<p role='alert' className='error'>
					{error}
				</p>
			)}
			{job?.state === "uncertain" && (
				<div className='ticket-recovery'>
					<button type='button' disabled={acting} onClick={() => act("reconcile", {})}>
						Reconcile execution
					</button>
				</div>
			)}
			{job?.state === "setup-failed" && (
				<div className='ticket-recovery'>
					<span>Agent setup failed.</span>
					<button type='button' disabled={acting} onClick={() => act("reconcile", {})}>
						Retry setup
					</button>
				</div>
			)}
			{canQueueMerge && (
				<button type='button' disabled={acting} onClick={() => act("merge", {})}>
					Queue merge
				</button>
			)}
			{plan && (
				<div className='ticket-plan' {...panel("plan")}>
					{tab === "plan" && (
						<Suspense fallback={<p role='status'>Loading plan…</p>}>
							<div className='ticket-plan-markdown'>
								<Markdown skipHtml disallowedElements={["img"]}>
									{plan.text}
								</Markdown>
							</div>
							{awaitingReview && (
								<div className='ticket-plan-actions'>
									<button type='button' disabled={acting} onClick={() => selectTab("chat")}>
										Request changes
									</button>
									<button
										type='button'
										className='primary'
										disabled={acting}
										onClick={() =>
											act("approve", { revision: plan.revision }, () => selectTab("chat"))
										}
									>
										Approve
									</button>
								</div>
							)}
						</Suspense>
					)}
				</div>
			)}
			<div className='ticket-fields' {...panel("details")}>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void save({ title, description }).catch((err: unknown) =>
							setError(err instanceof Error ? err.message : "Cannot save ticket."),
						);
					}}
				>
					<label htmlFor={`${fieldId}-title`}>Title</label>
					<input
						id={`${fieldId}-title`}
						required
						maxLength={120}
						value={title}
						disabled={busy || ticket.status !== "backlog"}
						onChange={(event) => setTitle(event.target.value)}
					/>
					<label htmlFor={`${fieldId}-description`}>Description</label>
					<textarea
						className='ticket-description'
						id={`${fieldId}-description`}
						maxLength={4000}
						value={description}
						disabled={busy || ticket.status !== "backlog"}
						onChange={(event) => setDescription(event.target.value)}
					/>
					{ticket.status === "backlog" && (
						<button className='primary' disabled={busy}>
							Save
						</button>
					)}
					{ticket.status !== "backlog" && (
						<p>Scope is fixed after planning starts. Discuss changes in chat.</p>
					)}
				</form>
			</div>
			{tabs
				.filter((name) => name === "chat" || name === "history")
				.map((name) => {
					const history = name === "history";
					const id = history ? job?.plannerId : currentId;
					return (
						<div key={name} className='ticket-chat' {...panel(name)}>
							{id ? (
								history === (tab === "history") && (
									<Conversation
										key={id}
										id={id}
										api={api}
										changed={refresh}
										selected={tab === name}
										messagePath={`tickets/${ticket.id}/messages`}
										blocked={history || blocked}
										readOnly={history || ticket.status !== "in-progress"}
										drafts={drafts}
										workflowChanged={(value) => {
											setJob(value);
											refreshBoard();
										}}
									/>
								)
							) : (
								<p>
									{ticket.status === "backlog"
										? "Move this ticket to Ready for development to queue planning."
										: "Waiting for a ticket agent to start."}
								</p>
							)}
						</div>
					);
				})}
		</dialog>
	);
};
