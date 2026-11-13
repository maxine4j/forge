import type { AgentView } from "@forge/contracts/agents";
import { agentOptionsSchema, type AgentOptions, type AgentSettings } from "@forge/contracts/agents";
import { createTicketSchema, ticketSchema } from "@forge/contracts/tickets";
import {
	ticketWorkflowSchema,
	type Ticket,
	type TicketStatus,
	type CreateTicket,
	type MoveTicket,
	type TicketWorkflow,
	type EpicSummary,
} from "@forge/contracts/tickets";
import { useContext, useEffect, useRef, useState, useId } from "react";

import { Conversation } from "../agents/agent-chat.tsx";
import { AgentOptionsRevision, ExecutionSettings } from "../agents/execution-settings.tsx";
import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { EpicSelection } from "./epic-details.tsx";
import { RepositorySelection } from "./repository-selection.tsx";
import { TicketCost } from "./ticket-cost.tsx";
import { ticketLabels } from "./ticket-labels.ts";

export { ticketLabels } from "./ticket-labels.ts";

const tabLabels = { details: "Details", chat: "Chat", cost: "Cost" };
type TicketTab = keyof typeof tabLabels;
export interface TicketReadingState {
	snapshots: Map<string, AgentView>;
	scroll: { top: number; follow: boolean };
	tab?: TicketTab;
	title: string;
	description: string;
	repositoryIds: string[];
	epicId?: string | null;
}

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
	reading,
	epics,
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
	reading: Map<string, TicketReadingState>;
	epics: EpicSummary[];
}) => {
	const archived = !!ticket.archivedAt;
	const dialog = useRef<HTMLDialogElement>(null);
	const [state] = useState(() => {
		const saved = reading.get(ticket.id) ?? {
			snapshots: new Map<string, AgentView>(),
			scroll: { top: 0, follow: true },
			title: ticket.title,
			description: ticket.description,
			repositoryIds: ticket.repositoryIds,
			epicId: ticket.epicId ?? null,
		};
		reading.set(ticket.id, saved);
		return saved;
	});
	const snapshots = state.snapshots;
	const scrollState = state.scroll;
	const archiveDialog = useRef<HTMLDialogElement>(null);
	const fieldId = useId();
	const poller = useRef<ResourcePoller<TicketWorkflow> | undefined>(undefined);
	const [job, setJob] = useState<TicketWorkflow>();
	const [section, setTab] = useState<TicketTab | undefined>(state.tab);
	const [acting, setActing] = useState(false);
	const [title, setTitle] = useState(state.title);
	const [description, setDescription] = useState(state.description);
	const [repositoryIds, setRepositoryIds] = useState(state.repositoryIds);
	const [epicId, setEpicId] = useState(state.epicId ?? null);
	const unsavedRepositories = JSON.stringify(repositoryIds) !== JSON.stringify(ticket.repositoryIds);
	Object.assign(state, { title, description, repositoryIds, epicId, tab: section });
	const settingsKey = JSON.stringify(ticket.executionSettings);
	const [observedSettings, setObservedSettings] = useState(settingsKey);
	const [savedSettings, setSavedSettings] = useState<AgentSettings>();
	if (observedSettings !== settingsKey) {
		setObservedSettings(settingsKey);
		setSavedSettings(undefined);
	}
	const settings = savedSettings ?? ticket.executionSettings ?? {};
	const [error, setError] = useState("");
	const [moveError, setMoveError] = useState("");
	const [scopeError, setScopeError] = useState("");
	const [options, setOptions] = useState<AgentOptions>();
	const optionsRevision = useContext(AgentOptionsRevision);
	const [savingSettings, setSavingSettings] = useState(false);
	const [settingsError, setSettingsError] = useState("");
	useEffect(() => {
		let current = true;
		void api
			.read(`tickets/${ticket.id}/model-options`, agentOptionsSchema)
			.then((value) => {
				if (current) setOptions(value);
			})
			.catch(() => {
				if (current) setError("Models unavailable.");
			});
		return () => {
			current = false;
		};
	}, [api, ticket.id, optionsRevision]);
	const changeSettings = (value: AgentSettings) => {
		if (archived || savingSettings) return;
		setSettingsError("");
		setSavingSettings(true);
		void api
			.read(`tickets/${ticket.id}/settings`, ticketSchema, "PATCH", value)
			.then((updated) => {
				setSavedSettings(updated.executionSettings ?? {});
				refreshBoard();
			})
			.catch((err: unknown) =>
				setSettingsError(err instanceof Error ? err.message : "Cannot save execution settings."),
			)
			.finally(() => setSavingSettings(false));
	};
	const [archiveError, setArchiveError] = useState("");
	const [refresh] = useState(() => () => poller.current?.refresh());
	useEffect(refresh, [refresh, ticket.status, ticket.canReturnToBacklog]);
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
	const currentId = job?.implementerId ?? job?.plannerId;
	const plan = job?.plan;
	const awaitingReview =
		ticket.status === "in-progress" && job?.phase === "planning" && job.state === "idle" && !!plan;
	const tabs: TicketTab[] = ["details", "chat", "cost"];
	const tab = section ?? (currentId || job?.state === "queued" ? "chat" : "details");
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
	const steering = !!job && ["implementation", "rebase"].includes(job.phase) && job.state === "running";
	const blocked = !job || (!steering && !["idle", "failed"].includes(job.state)) || ticket.status !== "in-progress";
	const implementation = job?.approvedRevision ? (
		<div className='ticket-implementation-divider' role='separator' aria-label='Plan approved · Implementation'>
			Plan approved · Implementation
			{["queued", "dispatching", "setup-failed"].includes(job.state) && (
				<p role='status'>Implementation: {job.state}</p>
			)}
		</div>
	) : undefined;
	const target = ticket.status === "backlog" ? "todo" : ticket.canReturnToBacklog ? "backlog" : undefined;
	const canQueueMerge =
		ticket.status === "in-progress"
		&& job?.resultSha
		&& ((job.phase === "review" && job.state === "idle") || job.state === "failed");
	const act = (path: string, body: unknown, onSuccess?: () => void) => {
		if (archived || acting || !poller.current) return;
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
					<p>
						{ticket.title}
						{archived && <small> Archived · Read only</small>}
					</p>
				</div>
				<div className='ticket-details-actions'>
					<button
						type='button'
						aria-label='Archive ticket'
						title='Archive ticket'
						disabled={archived || busy || acting}
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
						disabled={archived || busy || !target || unsavedRepositories}
						onChange={(event) => {
							setMoveError("");
							void move(ticket.id, { status: event.target.value as TicketStatus })
								.catch((err: unknown) =>
									setMoveError(err instanceof Error ? err.message : "Cannot move ticket."),
								)
								.finally(refresh);
						}}
					>
						<option value={ticket.status}>{ticketLabels[ticket.status]}</option>
						{target && <option value={target}>{ticketLabels[target]}</option>}
					</select>
				</label>
				{unsavedRepositories && <small>Save repository selections before starting planning.</small>}
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
			{(scopeError || error || settingsError || moveError) && (
				<p role='alert' className='error'>
					{scopeError || settingsError || moveError || error}
				</p>
			)}
			{job?.state === "uncertain" && (
				<div className='ticket-recovery'>
					<button type='button' disabled={archived || acting} onClick={() => act("reconcile", {})}>
						Reconcile execution
					</button>
				</div>
			)}
			{job?.state === "setup-failed" && (
				<div className='ticket-recovery'>
					<span>Agent setup failed.</span>
					<button type='button' disabled={archived || acting} onClick={() => act("reconcile", {})}>
						Retry setup
					</button>
				</div>
			)}
			{canQueueMerge && (
				<button type='button' disabled={archived || acting} onClick={() => act("merge", {})}>
					Queue merge
				</button>
			)}
			<div className='ticket-fields' {...panel("details")}>
				<ExecutionSettings
					settings={settings}
					options={options}
					change={changeSettings}
					disabled={archived || savingSettings || ticket.status === "done"}
				/>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (archived || ticket.status !== "backlog") return;
						const input = createTicketSchema.safeParse({ title, description, repositoryIds, epicId });
						if (!input.success) {
							setScopeError(
								"Enter a title up to 120 characters and a description up to 4000 characters.",
							);
							return;
						}
						setScopeError("");
						void save(input.data).catch((err: unknown) =>
							setScopeError(err instanceof Error ? err.message : "Cannot save ticket. Retry."),
						);
					}}
				>
					<label htmlFor={`${fieldId}-title`}>Title</label>
					<input
						id={`${fieldId}-title`}
						required
						maxLength={120}
						value={title}
						disabled={archived || busy || ticket.status !== "backlog"}
						onChange={(event) => setTitle(event.target.value)}
					/>
					<label htmlFor={`${fieldId}-description`}>Description</label>
					<textarea
						className='ticket-description'
						id={`${fieldId}-description`}
						maxLength={4000}
						value={description}
						disabled={archived || busy || ticket.status !== "backlog"}
						onChange={(event) => setDescription(event.target.value)}
					/>
					<RepositorySelection
						api={api}
						value={repositoryIds}
						change={setRepositoryIds}
						disabled={archived || busy || ticket.status !== "backlog"}
					/>
					<EpicSelection
						epics={epics}
						value={ticket.status === "backlog" && !archived ? epicId : (ticket.epicId ?? null)}
						change={setEpicId}
						disabled={archived || busy || ticket.status !== "backlog"}
					/>
					{!archived && ticket.status === "backlog" && (
						<button className='primary' disabled={busy}>
							Save
						</button>
					)}
					{ticket.status !== "backlog" && (
						<p>Scope is fixed after planning starts. Discuss changes in chat.</p>
					)}
				</form>
			</div>
			<div className='ticket-chat' {...panel("chat")}>
				{job?.state === "running" && <small role='status'>Applies to next turn</small>}
				{currentId ? (
					<Conversation
						key={currentId}
						snapshots={snapshots}
						scrollState={scrollState}
						id={currentId}
						api={api}
						changed={refresh}
						selected={tab === "chat"}
						messagePath={`tickets/${ticket.id}/messages`}
						executionSettings={settings}
						settingsChanged={changeSettings}
						settingsDisabled={archived || savingSettings}
						blocked={blocked || savingSettings}
						steer={steering}
						readOnly={
							archived
							|| ticket.status !== "in-progress"
							|| (!job?.implementerId && job?.phase !== "planning")
						}
						draftKey={`ticket:${ticket.id}`}
						drafts={drafts}
						planText={!job?.implementerId ? plan?.text : undefined}
						planAction={
							!archived
							&& awaitingReview && (
								<button
									type='button'
									className='primary'
									disabled={archived || acting}
									onClick={() => act("approve", { revision: plan!.revision })}
								>
									Approve plan
								</button>
							)
						}
						prefix={
							job?.implementerId && job.plannerId ? (
								<>
									<Conversation
										id={job.plannerId}
										api={api}
										changed={refresh}
										selected={tab === "chat"}
										readOnly
										historyOnly
										snapshots={snapshots}
									/>
									{implementation}
								</>
							) : undefined
						}
						suffix={!job?.implementerId ? implementation : undefined}
						workflowChanged={(value) => {
							setJob(value);
							refreshBoard();
						}}
					/>
				) : (
					<p>
						{ticket.status === "backlog"
							? "Move this ticket to Ready for development to queue planning."
							: "Waiting for a ticket agent to start."}
					</p>
				)}
				{blocked && ticket.status === "in-progress" && (
					<p role='status'>Messages unavailable while {job?.state ?? "loading"}.</p>
				)}
			</div>
			<div className='ticket-cost' {...panel("cost")}>
				{tab === "cost" && <TicketCost api={api} ticketId={ticket.id} />}
			</div>
		</dialog>
	);
};
