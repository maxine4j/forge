import type { AgentView } from "@forge/contracts/agents";
import {
	updateTicketSchema,
	ticketSchema,
	renderTicketPlan,
	resolveTicketWorkflowPreset,
} from "@forge/contracts/tickets";
import {
	ticketWorkflowSchema,
	ticketCheckpointSchema,
	ticketManualMergeSchema,
	type Ticket,
	type MoveTicket,
	type TicketWorkflow,
	type EpicSummary,
	type TicketExecutionSettings,
} from "@forge/contracts/tickets";
import { useEffect, useRef, useState, useId } from "react";
import { useLocation } from "react-router";

import { PlanMarkdown } from "../agents/agent-activity.tsx";
import { Conversation } from "../agents/agent-chat.tsx";
import { PlanReviewControls } from "../agents/plan-review-controls.tsx";
import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { Dropdown } from "../dropdown.tsx";
import { useDialogDismissal, useModalDraft, useModalNavigation } from "../navigation/controller.tsx";
import { useErrorState, useFailureToast } from "../toasts/toasts.tsx";
import { AgentAvatar } from "./agent-avatar.tsx";
import { EpicIcon } from "./epic-icon.tsx";
import { InlineTicketDescription, InlineTicketTitle } from "./inline-ticket-fields.tsx";
import { RepositorySelection } from "./repository-selection.tsx";
import { TicketAgentSettings } from "./ticket-agent-settings.tsx";
import { TicketCost } from "./ticket-cost.tsx";
import { TicketHistoryTimeline } from "./ticket-history.tsx";
import { ticketLabels } from "./ticket-labels.ts";
import { useTicketDialog, useDockedDismissal, type TicketPresentation } from "./ticket-presentation.tsx";

export { ticketLabels } from "./ticket-labels.ts";

const tabLabels = { details: "Details", chat: "Chat", history: "History", cost: "Cost", utils: "Utils" };
const tabs = Object.keys(tabLabels) as TicketTab[];
type TicketTab = keyof typeof tabLabels;
type UpdateTicket = ReturnType<typeof updateTicketSchema.parse>;
const tabIcons: Record<TicketTab, string> = {
	history: "M12 3a9 9 0 1 1-9 9M12 7v5l4 2M3 3v6h6",
	details: "M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6",
	chat: "M4 5h16v11H9l-5 4z",
	cost: "M12 3v18 M16 7H9a2.5 2.5 0 0 0 0 5h6a2.5 2.5 0 0 1 0 5H8",
	utils: "M4 8h16v12H4z M8 8V4h8v4 M4 13h16 M10 13v2h4v-2",
};
export interface TicketReadingState {
	snapshots: Map<string, AgentView>;
	scroll: { top: number; follow: boolean };
	tab?: TicketTab;
	descriptionDraft?: string;
}

export const TicketDetails = ({
	presentation,
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
	presentation: TicketPresentation;
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
	const navigation = useModalNavigation();
	const location = useLocation();
	const query = new URLSearchParams(location.search);
	const explicitTab = query.get("tab");
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
	const [feedbackPending, setFeedbackPending] = useState(false);
	const [utility, setUtility] = useState<{ pending?: string; success?: string; error?: string }>({});
	const section = tabs.find((name) => name === explicitTab);
	const setTab = (nextTab: TicketTab) => {
		if (tab === nextTab) return;
		const next = new URLSearchParams(location.search);
		next.set("tab", nextTab);
		navigation.select(`${location.pathname}?${next}${location.hash}`);
	};
	const [acting, setActing] = useState(false);
	const dismissal = useDialogDismissal(busy || acting || returnPending);
	const archiveDismissal = useDialogDismissal(busy);
	const returnDismissal = useDialogDismissal(returnPending || busy);
	const actionPending = useRef(false);
	const [titleDraft, setTitleDraft] = useState<string>();
	const [titleError, setTitleError] = useErrorState();
	const editTitle = useRef<HTMLButtonElement>(null);
	const titleInput = useRef<HTMLInputElement>(null);
	const restoreTitleFocus = useRef(false);
	const [descriptionDraft, setDescriptionDraft] = useState(state.descriptionDraft);
	const release = useModalDraft(
		(titleDraft !== undefined && titleDraft !== ticket.title)
			|| (descriptionDraft !== undefined && descriptionDraft !== ticket.description),
		busy || acting || returnPending,
		() => {
			setTitleDraft(undefined);
			setDescriptionDraft(undefined);
			Object.assign(state, { descriptionDraft: undefined });
		},
		"ticket",
	);
	useEffect(() => {
		if (navigation.modal?.owner === "archive") archiveDialog.current?.showModal();
		else archiveDialog.current?.close();
		if (navigation.modal?.owner === "return") returnDialog.current?.showModal();
		else returnDialog.current?.close();
	}, [navigation.modal?.owner]);
	const [pendingRepositories, setPendingRepositories] = useState<string[]>();
	const [, setScopeError] = useErrorState();
	const editDescription = useRef<HTMLButtonElement>(null);
	const descriptionInput = useRef<HTMLTextAreaElement>(null);
	const restoreDescriptionFocus = useRef(false);
	const resetting = ticket.resetting || job?.state === "resetting";
	const editable = !archived && !resetting && ticket.status === "backlog";
	const parentId = ticket.epicId ?? null;
	const epic = epics.find(({ id }) => id === parentId);
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
	Object.assign(state, { descriptionDraft, ...(section ? { tab: section } : {}) });
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
	const [, setError] = useErrorState();
	const [, setMoveError] = useErrorState();
	const [savingSettings, setSavingSettings] = useState(false);
	const [, setSettingsError] = useErrorState();
	const settingsDisabled = archived || savingSettings || !!resetting || ticket.status !== "backlog";
	const changeSettings = (value: TicketExecutionSettings) => {
		if (settingsDisabled) return;
		const next = { ...settings, ...value };
		if (value.workflowPreset) delete next.skipPlanning;
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
	const [, setArchiveError] = useErrorState();
	const [refresh] = useState(() => () => poller.current?.refresh());
	useEffect(refresh, [refresh, ticket.status, ticket.canReturnToBacklog]);
	useTicketDialog(dialog, presentation);
	useDockedDismissal(presentation, busy || acting || returnPending);
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
	}, [api, ticket.id, setError]);
	const currentId = job?.implementerId ?? job?.plannerId;
	const plan = job?.plan;
	const planMarkdown = plan?.structured ? renderTicketPlan(plan.structured) : plan?.text;
	const reviewPlan =
		ticket.status === "in-progress"
		&& job?.phase === "planning"
		&& (job.state === "idle" || job.state === "failed")
		&& !job.approvedRevision
		&& !feedbackPending
			? plan
			: undefined;
	const tab = section ?? state.tab ?? (currentId || job?.state === "queued" ? "chat" : "details");
	useEffect(() => {
		if (section || !job || navigation.modal?.owner !== "ticket") return;
		const next = new URLSearchParams(location.search);
		next.set("tab", tab);
		navigation.select(`${location.pathname}?${next}${location.hash}`, true, location.key);
	}, [section, job, tab, location.pathname, location.search, location.hash, location.key, navigation]);
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
	useFailureToast(job?.resetError);
	useFailureToast(
		job?.state === "setup-failed"
			? job.providerSelectionError
				? "Select an available agent in Agent Settings, then retry setup."
				: "Agent setup failed."
			: undefined,
	);
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
			release(true);
			await navigation.completeConfirmation();
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
		&& !job?.contextFailure
		&& !job?.completionFailure
		&& job?.resultSha
		&& ((job.phase === "review" && job.state === "idle") || (job.state === "failed" && job.mergeRetryEligible));
	const mutate = (operation: () => Promise<TicketWorkflow | void>) => {
		if (archived || actionPending.current || !poller.current) return;
		actionPending.current = true;
		setActing(true);
		setError("");
		void poller.current
			.mutate(async () => {
				const updated = await operation();
				refreshBoard();
				return updated;
			})
			.finally(() => {
				actionPending.current = false;
				setActing(false);
			});
	};
	const act = (path: string, body: unknown, onSuccess?: () => void) =>
		mutate(async () => {
			const updated = await api.read(`tickets/${ticket.id}/${path}`, ticketWorkflowSchema, "POST", body);
			onSuccess?.();
			return updated;
		});
	const utilsUnavailable =
		archived || ticket.status !== "in-progress"
			? "Utilities are available for unarchived tickets in progress."
			: resetting
				? "Wait for the ticket reset to finish."
				: !job?.workspaceId
					? "An assigned workspace is required."
					: undefined;
	const utilsBusy = busy || acting || returnPending || savingSettings || feedbackPending;
	const utilsDisabled = !!utilsUnavailable || utilsBusy || !!job?.cleanupPending;
	const runUtility = (action: "commit-checkpoint" | "merge-into-main") => {
		if (utilsDisabled || actionPending.current || !poller.current) return;
		const checkpoint = action === "commit-checkpoint";
		if (
			!window.confirm(
				checkpoint
					? "Commit a checkpoint of all changes, including non-ignored untracked files?"
					: "Merge committed work into local main and mark this ticket Done?",
			)
		)
			return;
		setUtility({ pending: checkpoint ? "Committing checkpoint…" : "Merging branch…" });
		mutate(async () => {
			const path = `tickets/${ticket.id}/${action}`;
			try {
				if (checkpoint) {
					const result = await api.read(path, ticketCheckpointSchema, "POST", {});
					setUtility({
						success: `${result.outcome === "committed" ? "Checkpoint committed" : "Checkpoint unchanged"} · ${result.sha}`,
					});
					return;
				}
				const result = await api.read(path, ticketManualMergeSchema, "POST", {});
				setUtility({ success: `Merged into main · ${result.sha}` });
				return result.workflow;
			} catch (err) {
				setUtility({ error: err instanceof Error ? err.message : "Request failed. Try again." });
				throw err;
			}
		});
	};
	const approvePlan = !archived && reviewPlan && (
		<PlanReviewControls busy={acting} approve={() => act("approve", { revision: reviewPlan.revision })} />
	);
	return (
		<dialog
			ref={dialog}
			className={`ticket-details ticket-dialog ticket-${presentation}`}
			aria-labelledby='ticket-details-title'
			{...dismissal}
			onKeyDown={presentation === "docked" ? undefined : dismissal.onKeyDown}
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
							<Dropdown
								aria-label={parentId ? "Change epic" : "Add epic"}
								className='ticket-epic-trigger'
								emptyLabel='No epics available.'
								disabled={busy}
								value={parentId ?? ""}
								onChange={(id) => chooseEpic(id || null)}
								trigger={parentId ? <span aria-hidden='true' /> : "+ Add"}
								options={[
									...epics.map(({ id, title }) => ({
										value: id,
										label: `${id} · ${title}`,
										matchingLabel: `${id}\n${title}`,
										icon: <EpicIcon />,
									})),
									...(parentId
										? [{ value: "", label: "Remove epic", matchingLabel: "Remove epic" }]
										: []),
								]}
							/>
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
							<span className='ticket-key-label'>{ticket.id}</span>
						</h2>
						<span
							role='group'
							aria-label='Status'
							className={`ticket-status-pill ticket-status-${ticket.status}`}
						>
							{ticketLabels[ticket.status]}
						</span>
					</div>
				</div>
				<span className='ticket-details-status' role='status'>
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
				{ticket.assignee && (
					<AgentAvatar
						colour={ticket.assignee.avatarColour}
						symbol={ticket.assignee.avatarSymbol}
						name={ticket.assignee.name}
					/>
				)}
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
								navigation.open("return");
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
							navigation.open("archive");
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

			<dialog
				ref={archiveDialog}
				className='ticket-dialog ticket-archive-dialog'
				aria-labelledby={`${fieldId}-archive-title`}
				aria-describedby={`${fieldId}-archive-description`}
				{...archiveDismissal}
			>
				<h2 id={`${fieldId}-archive-title`}>Archive {ticket.id}?</h2>
				<p id={`${fieldId}-archive-description`}>
					This removes the ticket from the task board and keeps its details and history.
				</p>

				<div className='ticket-dialog-actions'>
					<button type='button' disabled={busy} onClick={navigation.dismiss}>
						Cancel
					</button>
					<button
						type='button'
						className='primary'
						disabled={busy}
						onClick={() => {
							setArchiveError("");
							void archive()
								.then(async () => {
									release();
									await navigation.completeConfirmation("ticket");
								})
								.catch((err: unknown) =>
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
				{...returnDismissal}
			>
				<h2 id={`${fieldId}-return-title`}>Return {ticket.id} to backlog?</h2>
				<p id={`${fieldId}-return-description`}>
					This stops ticket execution and removes its execution worktree and unmerged branch. Scope, settings
					and the latest saved plan are preserved.
				</p>

				<div className='ticket-dialog-actions'>
					<button type='button' disabled={returnPending} onClick={navigation.dismiss}>
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
				<div className='ticket-recovery'>
					<button type='button' disabled={acting} onClick={() => act("reconcile", {})}>
						Retry cleanup
					</button>
				</div>
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
							<PlanMarkdown text={planMarkdown!} />
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
					<label>
						Workflow
						<select
							value={resolveTicketWorkflowPreset(settings)}
							disabled={settingsDisabled}
							onChange={(event) =>
								changeSettings({
									workflowPreset: event.target.value as NonNullable<
										TicketExecutionSettings["workflowPreset"]
									>,
								})
							}
						>
							<option value='planner-subtasks'>Planner + subtasks</option>
							<option value='planner-implementer'>Planner + implementer</option>
							<option value='one-shot'>One shot, no planner</option>
						</select>
					</label>
					<TicketAgentSettings
						api={api}
						settings={settings}
						job={job}
						change={changeSettings}
						disabled={settingsDisabled}
					/>
					<RepositorySelection
						api={api}
						value={pendingRepositories ?? ticket.repositoryIds}
						change={(ids) => void changeRepositories(ids)}
						disabled={!editable || busy}
					/>
					<label>
						Agent input
						<select
							value={settings.acceptRecommendations ? "recommendations" : "ask"}
							disabled={settingsDisabled}
							onChange={(event) =>
								changeSettings({ acceptRecommendations: event.target.value === "recommendations" })
							}
						>
							<option value='ask'>Ask me</option>
							<option value='recommendations'>Accept recommendations</option>
						</select>
					</label>
				</fieldset>
				{ticket.status !== "backlog" && <p>Scope is fixed after execution starts. Discuss changes in chat.</p>}
			</div>
			<div className='ticket-chat' {...panel("chat")}>
				{job?.completionFailure && (
					<p role='alert'>
						{job.completionFailure === "incomplete"
							? "The implementer reported that the assignment is incomplete."
							: "The implementer did not provide a valid completion report."}{" "}
						Review the conversation and send guidance to continue.
					</p>
				)}
				{job?.contextFailure && (
					<p role='alert'>
						{
							{
								telemetry: "Context telemetry was unavailable.",
								headroom: "There was not enough context remaining for a safe checkpoint report.",
								checkpoint: "The worktree checkpoint could not be verified.",
								report: "The checkpoint report was missing or invalid.",
								"no-progress": "The handover did not include a new checkpoint.",
							}[job.contextFailure]
						}{" "}
						Review the worktree and send retry guidance in Chat to continue.
					</p>
				)}
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
						planMarkdown={!job?.implementerId ? planMarkdown : undefined}
						feedbackPending={job?.phase === "planning" ? setFeedbackPending : undefined}
						planAction={approvePlan && <div className='ticket-chat-plan-actions'>{approvePlan}</div>}
						prefix={
							job?.implementerId && (job.plannerId || job.previousImplementerIds?.length) ? (
								<>
									{job.plannerId && (
										<Conversation
											id={job.plannerId}
											api={api}
											changed={refresh}
											selected={tab === "chat"}
											readOnly
											historyOnly
											planText={plan?.text}
											planMarkdown={planMarkdown}
											snapshots={snapshots}
										/>
									)}
									{job.previousImplementerIds?.map((id) => (
										<Conversation
											key={id}
											id={id}
											api={api}
											changed={refresh}
											selected={tab === "chat"}
											readOnly
											historyOnly
											snapshots={snapshots}
										/>
									))}
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
			<div className='ticket-utils' {...panel("utils")}>
				{utilsUnavailable && <p>{utilsUnavailable}</p>}
				{job?.cleanupPending && <p>Workspace cleanup pending.</p>}
				{!utilsUnavailable && utilsBusy && !utility.pending && (
					<p>Wait for the current ticket update to finish.</p>
				)}
				<div className='ticket-utils-actions'>
					<button type='button' disabled={utilsDisabled} onClick={() => runUtility("commit-checkpoint")}>
						Commit checkpoint
					</button>
					<button type='button' disabled={utilsDisabled} onClick={() => runUtility("merge-into-main")}>
						Merge branch into main
					</button>
				</div>
				{(utility.pending || utility.success) && <p role='status'>{utility.pending ?? utility.success}</p>}
				{utility.error && <p role='alert'>{utility.error}</p>}
			</div>
		</dialog>
	);
};
