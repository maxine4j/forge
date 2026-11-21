import {
	createTicketSchema,
	ticketSchema,
	epicDetailSchema,
	type EpicSummary,
	type CreateTicket,
	type Ticket,
} from "@forge/contracts/tickets";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useSearchParams, useNavigate } from "react-router";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import {
	directModalParent,
	nextModal,
	useModalDialog,
	useModalDraft,
	useModalNavigation,
	useDialogDismissal,
} from "../navigation/controller.tsx";
import { InterfaceIcon } from "../navigation/interface-icon.tsx";
import { SectionTabs, SectionTab } from "../section-tabs.tsx";
import { useErrorState, useFailureToast } from "../toasts/toasts.tsx";
import { ToolbarButton } from "../toolbar-button.tsx";
import { backlogFiltersKey, readBacklogFilters, type BacklogFilters } from "./backlog-filters.ts";
import { BoardSettingsDialog, useBoardSettings } from "./board-settings-dialog.tsx";
import { EpicDetails, EpicSelection } from "./epic-details.tsx";
import { RepositorySelection } from "./repository-selection.tsx";
import { TaskBacklog } from "./task-backlog.tsx";
import { TaskBoard } from "./task-board.tsx";
import { TaskNotifications } from "./task-notifications.tsx";
import { useTickets } from "./ticket-controller.tsx";
const TicketEditor = ({
	api,
	visible,
	busy,
	close,
	save,
	epics,
	initialEpic,
}: {
	api: IWorkspaceApi;
	visible: boolean;
	busy: boolean;
	close: () => void;
	save: (input: CreateTicket) => Promise<void>;
	epics: EpicSummary[];
	initialEpic: string | null;
}) => {
	const dialog = useRef<HTMLDialogElement>(null);
	const titleInput = useRef<HTMLInputElement>(null);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [repositoryIds, setRepositoryIds] = useState<string[]>([]);
	const [epicId, setEpicId] = useState(initialEpic);
	const [, setError] = useErrorState();
	const release = useModalDraft(!!(title || description || repositoryIds.length || epicId !== initialEpic), busy);
	const dismissal = useDialogDismissal(busy);
	useModalDialog(dialog, visible);
	useEffect(() => {
		if (visible) titleInput.current?.focus();
	}, [visible]);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const input = createTicketSchema.safeParse({
			title,
			description,
			repositoryIds,
			epicId,
		});
		if (!input.success) {
			setError("Enter a title up to 120 characters and a description up to 4000 characters.");
			return;
		}
		setError("");
		try {
			await save(input.data);
			release();
			close();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Cannot save ticket. Retry.");
		}
	};
	return (
		<dialog ref={dialog} className='ticket-dialog' aria-labelledby='ticket-dialog-title' {...dismissal}>
			<div className='ticket-dialog-heading'>
				<h2 id='ticket-dialog-title'>Create ticket</h2>
				<button type='button' aria-label='Close ticket' disabled={busy} onClick={close}>
					✕
				</button>
			</div>
			<form onSubmit={(event) => void submit(event)}>
				<label>
					Title
					<input
						ref={titleInput}
						autoFocus
						required
						maxLength={120}
						value={title}
						disabled={busy}
						onChange={(event) => setTitle(event.target.value)}
					/>
				</label>
				<label>
					Description
					<textarea
						rows={7}
						maxLength={4000}
						value={description}
						disabled={busy}
						onChange={(event) => setDescription(event.target.value)}
					/>
				</label>
				<RepositorySelection api={api} value={repositoryIds} change={setRepositoryIds} disabled={busy} />
				<EpicSelection epics={epics} value={epicId} change={setEpicId} disabled={busy} />

				<div className='ticket-dialog-actions'>
					<button type='button' disabled={busy} onClick={close}>
						Cancel
					</button>
					<button className='primary' disabled={busy} type='submit'>
						{busy ? "Saving…" : "Create"}
					</button>
				</div>
			</form>
		</dialog>
	);
};

export const Tasks = ({ api, visible }: { api: IWorkspaceApi; visible: boolean }) => {
	const location = useLocation();
	const [search] = useSearchParams();
	const navigation = useModalNavigation();
	const navigate = useNavigate();
	const initializing = useRef(false);
	const linkedId = location.pathname === "/tasks" ? search.get("ticket") : null;
	const epicLink = location.pathname === "/tasks" ? search.get("epic") : null;
	const creatingEpic = visible && navigation.modal?.owner === "create-epic";
	const creating = visible && navigation.modal?.owner === "create-ticket";
	const initialEpic = navigation.modal?.selection ?? null;
	useEffect(() => {
		if (!visible || linkedId || !epicLink || navigation.modal || initializing.current) return;
		initializing.current = true;
		const base = directModalParent(location);
		if (!base) {
			initializing.current = false;
			return;
		}
		void (async () => {
			await navigate(base.pathname + base.search + base.hash, { replace: true, state: null });
			await navigate(location.pathname + location.search + location.hash, {
				state: nextModal(base, "epic"),
			});
			initializing.current = false;
		})();
	}, [visible, linkedId, epicLink, navigation.modal, location, navigate, search]);
	const [filters, setFilters] = useState(readBacklogFilters);
	const changeFilter = (key: keyof BacklogFilters, checked: boolean) => {
		const next = { ...filters, [key]: checked };
		setFilters(next);
		try {
			localStorage.setItem(backlogFiltersKey, JSON.stringify(next));
		} catch {
			/* Keep controls usable when storage is unavailable. */
		}
	};
	const [collapsed, setCollapsed] = useState<string[]>(() => {
		try {
			const value: unknown = JSON.parse(localStorage.getItem("forge.epics.collapsed.v1") ?? "[]");
			return Array.isArray(value)
				? value.filter((id): id is string => typeof id === "string" && /^EPIC-[1-9]\d*$/u.test(id))
				: [];
		} catch {
			return [];
		}
	});
	const toggleEpic = (id: string) => {
		setCollapsed((current) => {
			const next = current.includes(id) ? current.filter((value) => value !== id) : [...current, id];
			try {
				localStorage.setItem("forge.epics.collapsed.v1", JSON.stringify(next));
			} catch {
				/* Storage can be unavailable. */
			}
			return next;
		});
	};
	const closeEpic = () => {
		navigation.dismiss();
	};
	const openEpic = (id: string) => {
		rememberFocus();
		const next = new URLSearchParams(search);
		next.delete("ticket");
		next.delete("tab");
		next.set("epic", id);
		navigation.open("epic", `/tasks?${next}`);
	};
	const {
		tickets,
		setTickets,
		epics,
		setEpics,
		loading,
		setLoading,
		busy,
		error,
		setError,
		notice,
		setNotice,
		drafts,
		notifications,
		notificationError,
		notificationsLoaded,
		pulse,
		setPulse,
		load,
		mutate,
		move,
	} = useTickets();
	const showSettings = visible && navigation.modal?.owner === "board-settings";
	const board = useBoardSettings(api, visible);
	const closeTicket = () => navigation.dismiss();
	useFailureToast(
		epicLink && !creatingEpic && !loading && !error && !epics.some((epic) => epic.id === epicLink)
			? "Epic unavailable."
			: undefined,
		epicLink ?? undefined,
	);

	const view =
		search.get("view") === "notifications"
			? "notifications"
			: search.get("view") === "backlog"
				? "backlog"
				: "board";
	const [dragging, setDragging] = useState(false);
	const actionsBusy = busy || loading || (view === "board" && dragging);
	const opener = useRef<HTMLElement | null>(null);
	const wasOpen = useRef(false);
	useEffect(() => {
		if (linkedId || creating || epicLink || creatingEpic) {
			wasOpen.current = true;
			return;
		}
		if (!wasOpen.current || busy) return;
		wasOpen.current = false;
		const target = opener.current;
		if (target?.isConnected && !target.matches(":disabled")) target.focus();
		else document.getElementById(`tasks-tab-${view}`)?.focus();
	}, [linkedId, creating, epicLink, creatingEpic, busy, view]);
	const rememberFocus = () => {
		opener.current = document.activeElement as HTMLElement;
	};
	const open = (ticket: Ticket) => {
		if (!linkedId) rememberFocus();
		const next = new URLSearchParams(search);
		next.set("ticket", ticket.id);
		next.delete("epic");
		next.delete("tab");
		if (view === "notifications") next.set("tab", "chat");
		navigation.open("ticket", `/tasks?${next}${location.hash}`);
	};
	const create = () => {
		rememberFocus();
		navigation.open("create-ticket");
	};
	const createInEpic = (id: string) => {
		rememberFocus();
		const next = new URLSearchParams(search);
		next.delete("epic");
		next.delete("ticket");
		next.delete("tab");
		navigation.open("create-ticket", `/tasks?${next}`, id);
	};
	const refresh = () => {
		setLoading(true);
		setError("");
		load();
	};
	const selectView = (name: string, focus = false) => {
		const next = new URLSearchParams(search);
		if (name !== "board") next.set("view", name);
		else next.delete("view");
		if (name !== view) navigation.select(`/tasks${next.size ? `?${next}` : ""}`);
		if (focus) document.getElementById(`tasks-tab-${name}`)?.focus();
	};
	return (
		<div className='tasks'>
			<div className='tasks-toolbar'>
				<SectionTabs aria-label='Task views' className='tasks-tabs'>
					{(["board", "backlog", "notifications"] as const).map((name, index) => (
						<SectionTab
							key={name}
							className={
								name === "notifications"
									? `notifications-tab ${notifications.length ? "has-notifications" : ""} ${pulse ? `notifications-pulse ${pulse % 2 ? "" : "notifications-pulse-repeat"}` : ""}`
									: undefined
							}
							onAnimationEnd={() => setPulse(0)}
							id={`tasks-tab-${name}`}
							panel={`tasks-panel-${name}`}
							icon={<InterfaceIcon name={name} />}
							selected={view === name}
							tabIndex={view === name ? 0 : -1}
							onClick={() => selectView(name)}
							onKeyDown={(event) => {
								const next = {
									ArrowLeft: (index + 2) % 3,
									ArrowRight: (index + 1) % 3,
									Home: 0,
									End: 2,
								}[event.key];
								if (next === undefined) return;
								event.preventDefault();
								selectView(["board", "backlog", "notifications"][next]!, true);
							}}
						>
							{name === "board"
								? "Board"
								: name === "backlog"
									? "Backlog"
									: `Notifications (${notificationsLoaded ? notifications.length : "…"})`}
						</SectionTab>
					))}
				</SectionTabs>
				<div
					className='task-board-actions'
					hidden={view === "notifications"}
					role='group'
					aria-label={view === "board" ? "Board actions" : "Backlog actions"}
				>
					{view === "board" ? (
						<>
							<ToolbarButton
								type='button'
								className='board-icon-button'
								aria-label='Board settings'
								title='Board settings'
								disabled={dragging}
								onClick={() => navigation.open("board-settings")}
							>
								<InterfaceIcon name='settings' />
							</ToolbarButton>
							<ToolbarButton
								type='button'
								className='board-icon-button'
								aria-label={board.dispatchLabel}
								title={board.dispatchLabel}
								disabled={!board.settings || board.busy || dragging}
								onClick={() => void board.toggleDispatch()}
							>
								<InterfaceIcon name={board.settings?.dispatch === "running" ? "pause" : "play"} />
							</ToolbarButton>
						</>
					) : (
						<>
							<ToolbarButton
								type='button'
								disabled={actionsBusy}
								onClick={() => {
									rememberFocus();
									navigation.open("create-epic");
								}}
							>
								Create epic
							</ToolbarButton>
						</>
					)}
					<ToolbarButton type='button' className='primary' disabled={actionsBusy} onClick={create}>
						Create ticket
					</ToolbarButton>
				</div>
			</div>
			{(["board", "backlog", "notifications"] as const).map((name) => (
				<div
					key={name}
					id={`tasks-panel-${name}`}
					role='tabpanel'
					aria-labelledby={`tasks-tab-${name}`}
					hidden={view !== name}
					className='tasks-panel'
					tabIndex={0}
				>
					{view === name
						&& (name === "notifications" ? (
							<TaskNotifications
								items={notifications}
								api={api}
								drafts={drafts}
								loading={!notificationsLoaded && !notificationError}
								error={notificationError || error}
								refresh={load}
								open={open}
								openEpic={openEpic}
							/>
						) : name === "board" ? (
							<TaskBoard
								selectedId={linkedId}
								tickets={tickets.filter((ticket) => !ticket.archivedAt)}
								busy={busy}
								loading={loading}
								error={error || board.error}
								notice={board.notice || notice}
								open={open}
								move={move}
								onDragChange={setDragging}
								reportError={setError}
							/>
						) : (
							<TaskBacklog
								filters={filters}
								changeFilter={changeFilter}
								epics={epics}
								collapsed={collapsed}
								toggleEpic={toggleEpic}
								openEpic={openEpic}
								createInEpic={createInEpic}
								createUnassigned={create}
								tickets={tickets}
								busy={busy}
								loading={loading}
								error={error}
								notice={notice}
								open={open}
							/>
						))}
				</div>
			))}
			{showSettings && <BoardSettingsDialog api={api} board={board} close={navigation.dismiss} />}
			{creating && (
				<TicketEditor
					epics={epics}
					initialEpic={initialEpic}
					key='new'
					api={api}
					visible={visible}
					busy={busy}
					close={closeTicket}
					save={(input) =>
						mutate(async () => {
							const updated = await api.read("tickets", ticketSchema, "POST", input);
							setTickets((current) => [...current, updated]);
							setNotice(`${updated.id} saved.`);
						})
					}
				/>
			)}
			{visible
				&& (creatingEpic || epicLink)
				&& navigation.modal
				&& !creating
				&& !linkedId
				&& (() => {
					const epic = epics.find((value) => value.id === epicLink);
					if (!creatingEpic && !epic)
						return (
							<p>
								{loading ? "Loading epic…" : ""}
								<button onClick={refresh}>Retry</button>
								<button onClick={closeEpic}>Close epic</button>
							</p>
						);
					return (
						<EpicDetails
							key={epic?.id ?? "new-epic"}
							epic={epic}
							tickets={tickets.filter((ticket) => ticket.epicId === epic?.id && !ticket.archivedAt)}
							busy={busy}
							error={error}
							close={closeEpic}
							refresh={refresh}
							open={open}
							create={() => epic && createInEpic(epic.id)}
							save={(input) =>
								mutate(async () => {
									const saved = await api.read(
										epic ? `epics/${epic.id}` : "epics",
										epicDetailSchema,
										epic ? "PATCH" : "POST",
										input,
									);
									setEpics((current) =>
										current.some((value) => value.id === saved.id)
											? current.map((value) => (value.id === saved.id ? saved : value))
											: [...current, saved],
									);
									if (!epic) {
										const next = new URLSearchParams(search);
										next.set("epic", saved.id);
										navigation.replace("epic", `/tasks?${next}`);
									}
								})
							}
						/>
					);
				})()}
		</div>
	);
};
