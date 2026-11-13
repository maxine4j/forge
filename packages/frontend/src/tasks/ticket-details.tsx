import type { AgentView } from "@forge/contracts/agents";
import { agentOptionsSchema, type AgentOptions, type AgentSettings } from "@forge/contracts/agents";
import { updateTicketSchema, ticketSchema } from "@forge/contracts/tickets";
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

import { PlanMarkdown } from "../agents/agent-activity.tsx";
import { Conversation } from "../agents/agent-chat.tsx";
import { AgentOptionsRevision, ExecutionSettings } from "../agents/execution-settings.tsx";
import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { EpicIcon } from "./epic-icon.tsx";
import { RepositorySelection } from "./repository-selection.tsx";
import { TicketCost } from "./ticket-cost.tsx";
import { ticketLabels } from "./ticket-labels.ts";

export { ticketLabels } from "./ticket-labels.ts";

const tabLabels = { details: "Details", chat: "Chat", cost: "Cost" };
type TicketTab = keyof typeof tabLabels;
const tabIcons: Record<TicketTab, string> = {
	details: "M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6",
	chat: "M4 5h16v11H9l-5 4z",
	cost: "M12 3v18 M16 7H9a2.5 2.5 0 0 0 0 5h6a2.5 2.5 0 0 1 0 5H8",
};
export interface TicketReadingState {
	snapshots: Map<string, AgentView>;
	scroll: { top: number; follow: boolean };
	tab?: TicketTab;
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
	openEpic,
}: {
	ticket: Ticket;
	api: IWorkspaceApi;
	busy: boolean;
	close: () => void;
	archive: () => Promise<void>;
	save: (input: CreateTicket, closeAfterSave?: boolean) => Promise<void>;
	move: (id: string, input: MoveTicket) => Promise<void>;
	refreshBoard: () => void;
	drafts: Map<string, string>;
	reading: Map<string, TicketReadingState>;
	epics: EpicSummary[];
	openEpic: (id: string) => void;
}) => {
	const archived = !!ticket.archivedAt;
	const dialog = useRef<HTMLDialogElement>(null);
	const [state] = useState(() => {
		const saved = reading.get(ticket.id) ?? {
			snapshots: new Map<string, AgentView>(),
			scroll: { top: 0, follow: true },
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
	const [titleDraft, setTitleDraft] = useState<string>();
	const [titleError, setTitleError] = useState("");
	const editTitle = useRef<HTMLButtonElement>(null);
	const titleInput = useRef<HTMLInputElement>(null);
	const restoreTitleFocus = useRef(false);
	const [description, setDescription] = useState(state.description);
	const [repositoryIds, setRepositoryIds] = useState(state.repositoryIds);
	const [epicId, setEpicId] = useState(state.epicId ?? null);
	const editable = !archived && ticket.status === "backlog";
	const parentId = editable ? epicId : (ticket.epicId ?? null);
	const epic = epics.find(({ id }) => id === parentId);
	const epicPicker = useRef<HTMLDivElement>(null);
	const chooseEpic = (id: string | null) => {
		epicPicker.current?.hidePopover();
		setEpicId(id);
	};
	const unsavedRepositories = JSON.stringify(repositoryIds) !== JSON.stringify(ticket.repositoryIds);
	Object.assign(state, { description, repositoryIds, epicId, tab: section });
	const editingTitle = editable && titleDraft !== undefined;
	useEffect(() => {
		if (editingTitle) titleInput.current?.focus();
		else if (!busy && restoreTitleFocus.current) {
			restoreTitleFocus.current = false;
			editTitle.current?.focus();
		}
	}, [editingTitle, busy]);
	const finishTitleEdit = () => {
		restoreTitleFocus.current = true;
		setTitleError("");
		setTitleDraft(undefined);
	};
	const saveTitle = async () => {
		if (!editingTitle || busy) return;
		const input = updateTicketSchema.safeParse({
			title: titleDraft,
			description: ticket.description,
			repositoryIds: ticket.repositoryIds,
		});
		if (!input.success) {
			setTitleError("Enter a title up to 120 characters.");
			titleInput.current?.focus();
			return;
		}
		if (input.data.title === ticket.title) {
			finishTitleEdit();
			return;
		}
		setTitleError("");
		try {
			await save(input.data, false);
			finishTitleEdit();
		} catch (err) {
			setTitleError(err instanceof Error ? err.message : "Cannot save title. Retry.");
		}
	};
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
	const reviewPlan =
		ticket.status === "in-progress" && job?.phase === "planning" && job.state === "idle" && !job.approvedRevision
			? plan
			: undefined;
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
	const approvePlan = !archived && reviewPlan && (
		<button
			type='button'
			className='primary'
			disabled={acting}
			onClick={() => act("approve", { revision: reviewPlan.revision })}
		>
			Approve plan
		</button>
	);
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
					<div className='ticket-details-key-row'>
						{parentId && (
							<>
								<button
									type='button'
									className='ticket-epic-link'
									title={epic ? `${epic.id} · ${epic.title}` : parentId}
									disabled={busy}
									onClick={() => openEpic(parentId)}
								>
									<EpicIcon />
									<span>{epic ? `${epic.id} · ${epic.title}` : parentId}</span>
								</button>
							</>
						)}
						{editable && (
							<button
								type='button'
								className='ticket-epic-trigger'
								aria-label={parentId ? "Change epic" : "Add epic"}
								title={parentId ? "Change epic" : "Add epic"}
								popoverTarget={`${fieldId}-epics`}
								disabled={busy}
							>
								{parentId ? <span className='ticket-chevron' aria-hidden='true' /> : "+ Add"}
							</button>
						)}
						{(parentId || editable) && (
							<span className='ticket-breadcrumb-divider' aria-hidden='true'>
								/
							</span>
						)}
						<h2 id='ticket-details-title'>
							<span
								className={`ticket-type ${ticket.status === "done" ? "ticket-complete" : ""}`}
								aria-hidden='true'
							>
								✓
							</span>
							{ticket.id}
						</h2>
						<div className={`ticket-status-select ticket-status-${ticket.status}`}>
							<select
								aria-label='Status'
								value={ticket.status}
								disabled={archived || busy || !target || unsavedRepositories || editingTitle}
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
							<span className='ticket-chevron' aria-hidden='true' />
						</div>
					</div>
					{editable && (
						<div
							ref={epicPicker}
							id={`${fieldId}-epics`}
							popover='auto'
							className='ticket-picker ticket-epic-picker'
							role='group'
							aria-label='Choose epic'
						>
							{epics.map(({ id, title }) => (
								<button
									key={id}
									type='button'
									aria-pressed={id === parentId}
									onClick={() => chooseEpic(id)}
								>
									<EpicIcon />
									<span>
										{id} · {title}
									</span>
								</button>
							))}
							{epics.length === 0 && <p>No epics available.</p>}
							{parentId && (
								<button type='button' className='ticket-picker-clear' onClick={() => chooseEpic(null)}>
									Remove epic
								</button>
							)}
						</div>
					)}
				</div>
				<div className='ticket-details-actions'>
					<button
						type='button'
						className='ticket-archive-action'
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
			{editingTitle ? (
				<form
					className='ticket-title-editor'
					onSubmit={(event) => {
						event.preventDefault();
						void saveTitle();
					}}
					onKeyDown={(event) => {
						if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
						event.preventDefault();
						if (!busy) finishTitleEdit();
					}}
				>
					<input
						ref={titleInput}
						aria-label='Title'
						aria-invalid={titleError ? true : undefined}
						maxLength={120}
						value={titleDraft}
						readOnly={busy}
						onChange={(event) => setTitleDraft(event.target.value)}
					/>
					<button type='submit' aria-label='Save title' title='Save title' disabled={busy}>
						✓
					</button>
					<button
						type='button'
						aria-label='Discard title changes'
						title='Discard title changes'
						disabled={busy}
						onClick={finishTitleEdit}
					>
						✕
					</button>
				</form>
			) : (
				<h3 className='ticket-title'>
					{editable ? (
						<button
							ref={editTitle}
							type='button'
							aria-label={`Edit title: ${ticket.title}`}
							title='Edit title'
							disabled={busy}
							onClick={() => setTitleDraft(ticket.title)}
						>
							{ticket.title}
						</button>
					) : (
						ticket.title
					)}
				</h3>
			)}
			{archived && <small>Archived · Read only</small>}
			{editingTitle && titleError && (
				<p role='alert' className='error'>
					{titleError}
				</p>
			)}
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
				{unsavedRepositories && <small>Save repository selections before starting planning.</small>}
				<span role='status'>
					{reviewPlan
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
						<svg
							width='15'
							height='15'
							viewBox='0 0 24 24'
							fill='none'
							stroke='currentColor'
							strokeWidth='1.75'
							strokeLinecap='round'
							strokeLinejoin='round'
							aria-hidden='true'
						>
							<path d={tabIcons[name]} />
						</svg>
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
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (!editable || busy || editingTitle) return;
						const input = updateTicketSchema.safeParse({
							title: ticket.title,
							description,
							repositoryIds,
							epicId,
						});
						if (!input.success) {
							setScopeError("Enter a description up to 4000 characters.");
							return;
						}
						setScopeError("");
						void save(input.data).catch((err: unknown) =>
							setScopeError(err instanceof Error ? err.message : "Cannot save ticket. Retry."),
						);
					}}
				>
					<label htmlFor={`${fieldId}-description`}>Description</label>
					<textarea
						id={`${fieldId}-description`}
						rows={4}
						maxLength={4000}
						value={description}
						disabled={archived || busy || ticket.status !== "backlog"}
						onChange={(event) => setDescription(event.target.value)}
					/>
					{plan && (
						<section className='ticket-details-plan' aria-labelledby={`${fieldId}-plan-title`}>
							<h3 id={`${fieldId}-plan-title`}>Plan</h3>
							<div className='ticket-plan-markdown'>
								<PlanMarkdown text={plan.text} />
							</div>
							{approvePlan && (
								<div className='ticket-plan-actions'>
									<button type='button' onClick={() => selectTab("chat")}>
										Request changes
									</button>
									{approvePlan}
								</div>
							)}
						</section>
					)}
					<RepositorySelection
						api={api}
						value={repositoryIds}
						change={setRepositoryIds}
						disabled={archived || busy || ticket.status !== "backlog"}
					/>
					<fieldset className='ticket-agent-settings'>
						<legend>Agent Settings</legend>
						<ExecutionSettings
							settings={settings}
							options={options}
							change={changeSettings}
							disabled={archived || savingSettings || ticket.status === "done"}
						/>
					</fieldset>
					{!archived && ticket.status === "backlog" && (
						<button className='primary ticket-details-save' disabled={busy || editingTitle}>
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
						planAction={approvePlan}
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
