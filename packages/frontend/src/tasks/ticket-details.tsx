import {
	ticketWorkflowSchema,
	type Ticket,
	type TicketStatus,
	type CreateTicket,
	type MoveTicket,
	type TicketWorkflow,
} from "@forge/contracts/tickets";
import { useEffect, useRef, useState, useId } from "react";

import { Conversation } from "../agents/agent-chat.tsx";
import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";

export const ticketLabels: Record<TicketStatus, string> = {
	backlog: "Backlog",
	todo: "To do",
	"in-progress": "In progress",
	"in-review": "In review",
	merging: "Merging",
	done: "Done",
};

export const TicketDetails = ({
	ticket,
	api,
	busy,
	close,
	save,
	move,
	drafts,
}: {
	ticket: Ticket;
	api: IWorkspaceApi;
	busy: boolean;
	close: () => void;
	save: (input: CreateTicket) => Promise<void>;
	move: (id: string, input: MoveTicket) => Promise<void>;
	drafts: Map<string, string>;
}) => {
	const dialog = useRef<HTMLDialogElement>(null);
	const fieldId = useId();
	const poller = useRef<ResourcePoller<TicketWorkflow> | undefined>(undefined);
	const [job, setJob] = useState<TicketWorkflow>();
	const [tab, setTab] = useState(ticket.status === "backlog" ? "details" : "chat");
	const [title, setTitle] = useState(ticket.title);
	const [description, setDescription] = useState(ticket.description);
	const [error, setError] = useState("");
	const [history, setHistory] = useState(false);
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
	const currentId = ticket.status === "todo" ? job?.plannerId : (job?.implementerId ?? job?.plannerId);
	const id = history ? job?.plannerId : currentId;
	const blocked =
		history || !job || !["idle", "failed"].includes(job.state) || ["backlog", "done"].includes(ticket.status);
	const target =
		ticket.status === "backlog"
			? "todo"
			: ticket.status === "todo"
				? "in-progress"
				: ticket.status === "in-review"
					? "merging"
					: undefined;
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
				<button type='button' aria-label='Close ticket' disabled={busy} onClick={close}>
					✕
				</button>
			</div>
			<div className='ticket-details-toolbar'>
				<label>
					Status
					<select
						aria-label='Status'
						value={ticket.status}
						disabled={busy}
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
					{job?.state ?? "loading"}
					{job?.plan ? ` · Plan revision ${job.plan.revision}` : ""}
				</span>
			</div>
			<nav aria-label='Ticket sections' className='ticket-details-tabs'>
				<button type='button' aria-pressed={tab === "details"} onClick={() => setTab("details")}>
					Details
				</button>
				<button type='button' aria-pressed={tab === "chat"} onClick={() => setTab("chat")}>
					Chat
				</button>
				{job?.implementerId && (
					<button
						type='button'
						aria-pressed={history}
						onClick={() => {
							setHistory(!history);
							setTab("chat");
						}}
					>
						{history ? "Implementation chat" : "Planning history"}
					</button>
				)}
			</nav>
			{error && (
				<p role='alert' className='error'>
					{error}
				</p>
			)}
			{job?.state === "uncertain" && (
				<div className='ticket-recovery'>
					<span>Execution needs reconciliation; no input will be replayed.</span>
					<button
						onClick={() => {
							void api
								.read(`tickets/${ticket.id}/reconcile`, ticketWorkflowSchema, "POST", {})
								.then(setJob)
								.catch((err: unknown) =>
									setError(err instanceof Error ? err.message : "Cannot reconcile execution."),
								);
						}}
					>
						Reconcile execution
					</button>
				</div>
			)}
			<div className='ticket-fields' hidden={tab !== "details"}>
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
			<div className='ticket-chat' hidden={tab !== "chat"}>
				{id ? (
					<Conversation
						key={id}
						id={id}
						api={api}
						changed={refresh}
						selected={tab === "chat"}
						messagePath={`tickets/${ticket.id}/messages`}
						blocked={blocked}
						readOnly={history || ["backlog", "done"].includes(ticket.status)}
						drafts={drafts}
						workflowChanged={setJob}
					/>
				) : (
					<p>
						{ticket.status === "backlog"
							? "Move this ticket to To do to start planning."
							: "Queued for an available agent slot. Up to three agents can run at once."}
					</p>
				)}
			</div>
		</dialog>
	);
};
