import type { AgentView } from "@forge/contracts/agents";
import { agentOptionsSchema, resolveAgentSettings, type AgentOptions } from "@forge/contracts/agents";
import { updateTicketSchema, ticketSchema } from "@forge/contracts/tickets";
import {
	ticketWorkflowSchema,
	type Ticket,
	type MoveTicket,
	type TicketWorkflow,
	type EpicSummary,
	type TicketExecutionSettings,
} from "@forge/contracts/tickets";
import { useContext, useEffect, useRef, useState, useId } from "react";

import { PlanMarkdown } from "../agents/agent-activity.tsx";
import { Conversation } from "../agents/agent-chat.tsx";
import { AgentOptionsRevision, ExecutionSettings } from "../agents/execution-settings.tsx";
import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { EpicIcon } from "./epic-icon.tsx";
import { InlineTicketDescription, InlineTicketTitle } from "./inline-ticket-fields.tsx";
import { RepositorySelection } from "./repository-selection.tsx";
import { TicketCost } from "./ticket-cost.tsx";
import { TicketHistoryTimeline } from "./ticket-history.tsx";
import { ticketLabels } from "./ticket-labels.ts";

export { ticketLabels } from "./ticket-labels.ts";

const tabLabels = { details: "Details", chat: "Chat", history: "History", cost: "Cost" };
type TicketTab = keyof typeof tabLabels;
type UpdateTicket = ReturnType<typeof updateTicketSchema.parse>;
const tabIcons: Record<TicketTab, string> = {
	history: "M12 3a9 9 0 1 1-9 9M12 7v5l4 2M3 3v6h6",
	details: "M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6",
	chat: "M4 5h16v11H9l-5 4z",
	cost: "M12 3v18 M16 7H9a2.5 2.5 0 0 0 0 5h6a2.5 2.5 0 0 1 0 5H8",
};
export interface TicketReadingState {
	snapshots: Map<string, AgentView>;
	scroll: { top: number; follow: boolean };
	tab?: TicketTab;
	descriptionDraft?: string;
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
	save: (input: UpdateTicket) => Promise<void>;
	move: (id: string, input: MoveTicket) => Promise<void>;
	refreshBoard: () => void;
	drafts: Map<string, string>;
	reading: Map<string, TicketReadingState>;
	epics: EpicSummary[];
	openEpic: (id: string) => void;
}) => {
	const archived = !!ticket.archivedAt;
	const dialog = useRef<HTMLDialogElement>(null);
	const [state] = useState<TicketReadingState>(() => {
		const saved: TicketReadingState = reading.get(ticket.id) ?? {
			snapshots: new Map<string, AgentView>(),
			scroll: { top: 0, follow: true },
		};
		reading.set(ticket.id, saved);
		return saved;
	});
	const snapshots = state.snapshots;
	const scrollState = state.scroll;
	const archiveDialog = useRef<HTMLDialogElement>(null);
	const returnDialog = useRef<HTMLDialogElement>(null);
	const returning = useRef(false);
	const [returnPending, setReturnPending] = useState(false);
	const fieldId = useId();
	const poller = useRef<ResourcePoller<TicketWorkflow> | undefined>(undefined);
	const [job, setJob] = useState<TicketWorkflow>();
	const [section, setTab] = useState<TicketTab | undefined>(state.tab);
	const [acting, setActing] = useState(false);
	const actionPending = useRef(false);
	const [titleDraft, setTitleDraft] = useState<string>();
	const [titleError, setTitleError] = useState("");
	const editTitle = useRef<HTMLButtonElement>(null);
	const titleInput = useRef<HTMLInputElement>(null);
	const restoreTitleFocus = useRef(false);
	const [descriptionDraft, setDescriptionDraft] = useState(state.descriptionDraft);
	const [pendingRepositories, setPendingRepositories] = useState<string[]>();
	const [scopeError, setScopeError] = useState("");
	const editDescription = useRef<HTMLButtonElement>(null);
	const descriptionInput = useRef<HTMLTextAreaElement>(null);
	const restoreDescriptionFocus = useRef(false);
	const resetting = ticket.resetting || job?.state === "resetting";
	const editable = !archived && !resetting && ticket.status === "backlog";
	const parentId = ticket.epicId ?? null;
	const epic = epics.find(({ id }) => id === parentId);
	const epicPicker = useRef<HTMLDivElement>(null);
	const saveScope = async (changes: Partial<UpdateTicket>) => {
		if (!editable || busy) return false;
		setScopeError("");
		try {
			await save(
				updateTicketSchema.parse({
					title: ticket.title,
					description: ticket.description,
					repositoryIds: ticket.repositoryIds,
					...changes,
				}),
			);
			return true;
		} catch (err) {
			setScopeError(err instanceof Error ? err.message : "Cannot save ticket. Retry.");
			return false;
		}
	};
	const chooseEpic = (id: string | null) => {
		epicPicker.current?.hidePopover();
		if (id !== parentId) void saveScope({ epicId: id });
	};
	const changeRepositories = async (ids: string[]) => {
		setPendingRepositories(ids);
		await saveScope({ repositoryIds: ids });
		setPendingRepositories(undefined);
	};
	const editingDescription = editable && descriptionDraft !== undefined;
	useEffect(() => {
		if (editingDescription) descriptionInput.current?.focus();
	}, [editingDescription]);
	useEffect(() => {
		if (!editingDescription && !busy && restoreDescriptionFocus.current) {
			restoreDescriptionFocus.current = false;
			editDescription.current?.focus();
		}
	}, [editingDescription, busy]);
	const finishDescriptionEdit = () => {
		restoreDescriptionFocus.current = true;
		setDescriptionDraft(undefined);
		setScopeError("");
	};
	const saveDescription = async () => {
		if (!editingDescription || busy) return;
		if (descriptionDraft === ticket.description || (await saveScope({ description: descriptionDraft }))) {
			finishDescriptionEdit();
		}
	};
	Object.assign(state, { descriptionDraft, tab: section });
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
			await save(input.data);
			finishTitleEdit();
		} catch (err) {
			setTitleError(err instanceof Error ? err.message : "Cannot save title. Retry.");
		}
	};
	const settingsKey = JSON.stringify(ticket.executionSettings);
	const [observedSettings, setObservedSettings] = useState(settingsKey);
	const [savedSettings, setSavedSettings] = useState<TicketExecutionSettings>();
	const [pendingSettings, setPendingSettings] = useState<TicketExecutionSettings>();
	if (observedSettings !== settingsKey) {
		setObservedSettings(settingsKey);
		setSavedSettings(undefined);
	}
	const settings = pendingSettings ?? savedSettings ?? ticket.executionSettings ?? {};
	const [error, setError] = useState("");
	const [moveError, setMoveError] = useState("");
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
	}, [api, ticket.id, job?.phase, job?.plannerId, job?.implementerId, optionsRevision]);
	const settingsDisabled = archived || savingSettings || !!resetting || ticket.status === "done";
	const changeSettings = (value: TicketExecutionSettings) => {
		if (settingsDisabled) return;
		const next = { ...settings, ...value };
		setSettingsError("");
		setSavingSettings(true);
		setPendingSettings(next);
		void api
			.read(`tickets/${ticket.id}/settings`, ticketSchema, "PATCH", next)
			.then((updated) => {
				setSavedSettings(updated.executionSettings ?? {});
				refreshBoard();
			})
			.catch((err: unknown) =>
				setSettingsError(err instanceof Error ? err.message : "Cannot save execution settings."),
			)
			.finally(() => {
				setPendingSettings(undefined);
				setSavingSettings(false);
			});
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
	const tabs: TicketTab[] = ["details", "chat", "history", "cost"];
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
	const canReturn = !archived && !!ticket.canReturnToBacklog && !resetting;
	const returnToBacklog = async () => {
		if (!canReturn || busy || returning.current) return;
		returning.current = true;
		setReturnPending(true);
		setMoveError("");
		try {
			await move(ticket.id, { status: "backlog" });
			returnDialog.current?.close();
		} catch (err) {
			setMoveError(err instanceof Error ? err.message : "Cannot move ticket.");
		} finally {
			returning.current = false;
			setReturnPending(false);
			refresh();
		}
	};
	const canQueueMerge =
		ticket.status === "in-progress"
		&& job?.resultSha
		&& ((job.phase === "review" && job.state === "idle") || job.state === "failed");
	const act = (path: string, body: unknown, onSuccess?: () => void) => {
		if (archived || actionPending.current || !poller.current) return;
		actionPending.current = true;
		setActing(true);
		setError("");
		void poller.current
			.mutate(async () => {
				const updated = await api.read(`tickets/${ticket.id}/${path}`, ticketWorkflowSchema, "POST", body);
				onSuccess?.();
				refreshBoard();
				return updated;
			})
			.finally(() => {
				actionPending.current = false;
				setActing(false);
			});
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
									<span>{parentId}</span>
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
					{!archived && ticket.canReturnToBacklog && (
						<button
							type='button'
							className='ticket-return-action'
							aria-label='Return to backlog'
							title='Return to backlog'
							disabled={busy || acting || !!resetting}
							onClick={() => {
								setMoveError("");
								returnDialog.current?.showModal();
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
								<path d='M3 10a9 9 0 1 1 2 8 M3 4v6h6' />
							</svg>
						</button>
					)}
					<button
						type='button'
						className='ticket-archive-action'
						aria-label='Archive ticket'
						title='Archive ticket'
						disabled={archived || busy || acting || !!resetting}
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
			<InlineTicketTitle
				value={ticket.title}
				draft={titleDraft}
				editable={editable}
				busy={busy}
				trigger={editTitle}
				input={titleInput}
				change={setTitleDraft}
				save={() => void saveTitle()}
				discard={finishTitleEdit}
				invalid={!!titleError}
			/>
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
			<dialog
				ref={returnDialog}
				className='ticket-dialog ticket-archive-dialog'
				aria-labelledby={`${fieldId}-return-title`}
				aria-describedby={`${fieldId}-return-description`}
				onCancel={(event) => {
					event.stopPropagation();
					event.preventDefault();
					if (!returnPending) returnDialog.current?.close();
				}}
			>
				<h2 id={`${fieldId}-return-title`}>Return {ticket.id} to backlog?</h2>
				<p id={`${fieldId}-return-description`}>
					This stops ticket execution and removes its execution worktree and unmerged branch. Scope, settings
					and the latest saved plan are preserved.
				</p>
				{moveError && (
					<p role='alert' className='error'>
						{moveError}
					</p>
				)}
				<div className='ticket-dialog-actions'>
					<button type='button' disabled={returnPending} onClick={() => returnDialog.current?.close()}>
						Cancel
					</button>
					<button
						type='button'
						className='primary'
						disabled={!canReturn || busy || returnPending}
						onClick={() => void returnToBacklog()}
					>
						{returnPending ? "Returning…" : "Return to backlog"}
					</button>
				</div>
			</dialog>
			<div className='ticket-sections-row'>
				<span role='status'>
					{resetting
						? job?.resetStage === "cleanup"
							? "Removing abandoned work…"
							: "Stopping ticket agents…"
						: reviewPlan
							? "Plan ready for review"
							: job?.state === "merge-queued"
								? "Queued to merge"
								: (job?.state ?? "Loading")}
				</span>

				<div role='tablist' aria-label='Ticket sections' className='section-tabs'>
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
			</div>
			{job?.resetError && (
				<div className='ticket-recovery' role='alert'>
					<span>{job.resetError}</span>
					<button type='button' disabled={acting} onClick={() => act("reconcile", {})}>
						Retry cleanup
					</button>
				</div>
			)}
			{(scopeError || error || settingsError) && (
				<p role='alert' className='error'>
					{scopeError || settingsError || error}
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
					<span>
						{options && !resolveAgentSettings(options, settings).supported
							? "Some agent settings are unavailable. Use Default for the model or thinking level, or choose an available permission mode, then retry."
							: "Agent setup failed."}
					</span>
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
				<div className='ticket-status-field'>
					<span id={`${fieldId}-status`}>Status</span>
					<span
						role='group'
						aria-labelledby={`${fieldId}-status`}
						className={`ticket-status-pill ticket-status-${ticket.status}`}
					>
						{ticketLabels[ticket.status]}
					</span>
				</div>
				<InlineTicketDescription
					value={ticket.description}
					draft={descriptionDraft}
					editable={editable}
					busy={busy}
					trigger={editDescription}
					input={descriptionInput}
					change={setDescriptionDraft}
					save={() => void saveDescription()}
					discard={finishDescriptionEdit}
				/>
				{plan && (
					<fieldset className='ticket-detail-section'>
						<legend>Plan</legend>
						{!archived && ticket.status === "backlog" && (
							<button
								type='button'
								disabled={acting || busy || !!resetting}
								onClick={() => act("clear-plan", {})}
							>
								Clear plan
							</button>
						)}
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
					</fieldset>
				)}
				<fieldset className='ticket-detail-section ticket-agent-settings'>
					<legend>Agent Settings</legend>
					<ExecutionSettings
						settings={settings}
						options={options}
						change={changeSettings}
						disabled={settingsDisabled}
					/>
					<RepositorySelection
						api={api}
						value={pendingRepositories ?? ticket.repositoryIds}
						change={(ids) => void changeRepositories(ids)}
						disabled={!editable || busy}
					/>
					{(
						[
							[
								"skipPlanning",
								"Skip planning",
								"Start implementation directly, using a saved plan or the current ticket scope.",
							],
							[
								"acceptRecommendations",
								"Accept recommendations",
								"Let the agent choose its recommended approach without preference or clarification questions. Plan approval and tool permissions still apply.",
							],
						] as const
					).map(([key, label, description]) => (
						<div key={key} className='ticket-execution-flag'>
							<label>
								<input
									type='checkbox'
									checked={settings[key] ?? false}
									disabled={settingsDisabled}
									aria-describedby={`${fieldId}-${key}`}
									onChange={(event) => changeSettings({ [key]: event.target.checked })}
								/>
								{label}
							</label>
							<p id={`${fieldId}-${key}`}>{description}</p>
						</div>
					))}
				</fieldset>
				{ticket.status !== "backlog" && <p>Scope is fixed after execution starts. Discuss changes in chat.</p>}
			</div>
			<div className='ticket-chat' {...panel("chat")}>
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
						settingsDisabled={settingsDisabled}
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
						planAction={approvePlan && <div className='ticket-chat-plan-actions'>{approvePlan}</div>}
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
							? plan
								? "Move this ticket to Ready for development to implement the saved plan."
								: "Move this ticket to Ready for development to queue execution."
							: "Waiting for a ticket agent to start."}
					</p>
				)}
			</div>
			<div className='ticket-history-panel' {...panel("history")}>
				<TicketHistoryTimeline key={ticket.id} api={api} ticketId={ticket.id} selected={tab === "history"} />
			</div>
			<div className='ticket-cost' {...panel("cost")}>
				{tab === "cost" && <TicketCost api={api} ticketId={ticket.id} />}
			</div>
		</dialog>
	);
};
