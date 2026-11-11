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
	save,
	move,
	refreshBoard,
	drafts,
}: {
	ticket: Ticket;
	api: IWorkspaceApi;
	busy: boolean;
	close: () => void;
	save: (input: CreateTicket) => Promise<void>;
	move: (id: string, input: MoveTicket) => Promise<void>;
	refreshBoard: () => void;
	drafts: Map<string, string>;
}) => {
	const dialog = useRef<HTMLDialogElement>(null);
	const fieldId = useId();
	const poller = useRef<ResourcePoller<TicketWorkflow> | undefined>(undefined);
	const [job, setJob] = useState<TicketWorkflow>();
	const [section, setTab] = useState<"details" | "plan" | "chat">();
	const [acting, setActing] = useState(false);
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
	const currentId = job?.phase === "planning" ? job.plannerId : job?.implementerId;
	const id = history ? job?.plannerId : currentId;
	const plan = job?.plan;
	const awaitingReview =
		ticket.status === "in-progress" && job?.phase === "planning" && job.state === "idle" && !!plan;
	const tab = section ?? (awaitingReview ? "plan" : currentId ? "chat" : "details");
	const blocked = history || !job || !["idle", "failed"].includes(job.state) || ticket.status !== "in-progress";
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
			<nav aria-label='Ticket sections' className='ticket-details-tabs'>
				<button type='button' aria-pressed={tab === "details"} onClick={() => setTab("details")}>
					Details
				</button>
				{plan && (
					<button type='button' aria-pressed={tab === "plan"} onClick={() => setTab("plan")}>
						Plan
					</button>
				)}
				<button type='button' aria-pressed={tab === "chat"} onClick={() => setTab("chat")}>
					Chat
				</button>
				{job?.implementerId && job.plannerId && (
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
			{plan && tab === "plan" && (
				<Suspense fallback={<p role='status'>Loading plan…</p>}>
					<div className='ticket-plan'>
						<div className='ticket-plan-markdown'>
							<Markdown skipHtml disallowedElements={["img"]}>
								{plan.text}
							</Markdown>
						</div>
						{awaitingReview && (
							<div className='ticket-plan-actions'>
								<button
									type='button'
									disabled={acting}
									onClick={() => {
										setHistory(false);
										setTab("chat");
									}}
								>
									Request changes
								</button>
								<button
									type='button'
									className='primary'
									disabled={acting}
									onClick={() => act("approve", { revision: plan.revision }, () => setTab("chat"))}
								>
									Approve
								</button>
							</div>
						)}
					</div>
				</Suspense>
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
						readOnly={history || ticket.status !== "in-progress"}
						drafts={drafts}
						workflowChanged={(value) => {
							setJob(value);
							refreshBoard();
						}}
					/>
				) : (
					<p>
						{ticket.status === "backlog"
							? "Move this ticket to Ready for development to start planning."
							: "Queued for an available agent slot. Up to three agents can run at once."}
					</p>
				)}
			</div>
		</dialog>
	);
};
