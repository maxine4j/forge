import {
	createTicketSchema,
	ticketSchema,
	ticketsSchema,
	epicsSchema,
	epicDetailSchema,
	type EpicSummary,
	type CreateTicket,
	type MoveTicket,
	type Ticket,
} from "@forge/contracts/tickets";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useLocation, useSearchParams } from "react-router";

import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { BoardSettingsDialog } from "./board-settings-dialog.tsx";
import { EpicDetails, EpicSelection } from "./epic-details.tsx";
import { RepositorySelection } from "./repository-selection.tsx";
import { TaskBacklog } from "./task-backlog.tsx";
import { TaskBoard } from "./task-board.tsx";
import { TicketDetails, ticketLabels as labels, type TicketReadingState } from "./ticket-details.tsx";
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
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [repositoryIds, setRepositoryIds] = useState<string[]>([]);
	const [epicId, setEpicId] = useState(initialEpic);
	const [error, setError] = useState("");
	useEffect(() => {
		if (visible) dialog.current?.showModal();
		else dialog.current?.close();
	}, [visible]);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const input = createTicketSchema.safeParse({ title, description, repositoryIds, epicId });
		if (!input.success) {
			setError("Enter a title up to 120 characters and a description up to 4000 characters.");
			return;
		}
		setError("");
		try {
			await save(input.data);
			close();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Cannot save ticket. Retry.");
		}
	};
	return (
		<dialog
			ref={dialog}
			className='ticket-dialog'
			aria-labelledby='ticket-dialog-title'
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) close();
			}}
		>
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
				{error && (
					<p role='alert' className='error'>
						{error}
					</p>
				)}
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
	const [search, setSearch] = useSearchParams();
	const linkedId = location.pathname === "/tasks" ? search.get("ticket") : null;
	const epicLink = location.pathname === "/tasks" ? search.get("epic") : null;
	const [epics, setEpics] = useState<EpicSummary[]>([]);
	const [creatingEpic, setCreatingEpic] = useState(false);
	const [initialEpic, setInitialEpic] = useState<string | null>(null);
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
		setCreatingEpic(false);
		const next = new URLSearchParams(search);
		next.delete("epic");
		setSearch(next);
	};
	const openEpic = (id: string) => {
		rememberFocus();
		const next = new URLSearchParams(search);
		next.set("view", "backlog");
		next.delete("ticket");
		next.set("epic", id);
		setSearch(next);
	};
	const [linked, setLinked] = useState<{ id: string; ticket?: Ticket; error?: string }>();
	const closeTicket = () => {
		setCreating(false);
		if (!search.has("ticket")) return;
		const next = new URLSearchParams(search);
		next.delete("ticket");
		setSearch(next);
	};
	const [tickets, setTickets] = useState<Ticket[]>([]);
	useEffect(() => {
		if (!linkedId) return;
		let current = true;
		void api.read(`tickets/${encodeURIComponent(linkedId)}`, ticketSchema).then(
			(ticket) => {
				if (current) setLinked({ id: linkedId, ticket });
			},
			() => {
				if (current) setLinked({ id: linkedId, error: "Ticket unavailable." });
			},
		);
		return () => {
			current = false;
		};
	}, [api, linkedId]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [creating, setCreating] = useState(false);
	const selectedTicket = linkedId && linked?.id === linkedId ? linked.ticket : undefined;
	useEffect(() => {
		if (!linkedId || tickets.some((ticket) => ticket.id === linkedId)) return;
		let current = true;
		void api.read(`tickets/${encodeURIComponent(linkedId)}`, ticketSchema).then(
			(ticket) => {
				if (current) setLinked({ id: ticket.id, ticket });
			},
			() => {
				if (current)
					setLinked((previous) =>
						previous?.id === linkedId && previous.ticket
							? previous
							: { id: linkedId, error: "Ticket unavailable." },
					);
			},
		);
		return () => {
			current = false;
		};
	}, [api, linkedId, tickets]);
	const [showSettings, setShowSettings] = useState(false);
	const active = useRef(true);
	const locked = useRef(false);
	const [drafts] = useState(() => new Map<string, string>());
	const [reading] = useState(() => new Map<string, TicketReadingState>());
	type Collection = { tickets: Ticket[]; epics: EpicSummary[] };
	const poller = useRef<ResourcePoller<Collection> | undefined>(undefined);
	const readCollection = useCallback(async (): Promise<Collection> => {
		const [tickets, epics] = await Promise.all([
			api.read("tickets", ticketsSchema),
			api.read("epics", epicsSchema),
		]);
		return { tickets, epics };
	}, [api]);
	const load = () => poller.current?.refresh();
	useEffect(() => {
		active.current = true;
		const polling = new ResourcePoller(
			readCollection,
			({ tickets: values, epics }) => {
				setEpics(epics);
				setTickets(values);
				setLinked((current) => {
					const ticket = values.find((value) => value.id === current?.id);
					return ticket ? { id: ticket.id, ticket } : current;
				});
				setError("");
				setLoading(false);
			},
			(message) => {
				setError(message);
				setLoading(false);
			},
			1000,
		);
		poller.current = polling;
		polling.refresh();
		return () => {
			polling.stop();
			poller.current = undefined;
			active.current = false;
		};
	}, [api, readCollection]);
	const mutate = async (operation: () => Promise<void>) => {
		if (locked.current) throw new Error("A ticket change is still saving.");
		locked.current = true;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			let failure: unknown;
			await poller.current?.mutate(async () => {
				try {
					await operation();
					return await readCollection();
				} catch (error) {
					failure = error;
					return await readCollection();
				}
			});
			if (failure) throw failure;
		} finally {
			locked.current = false;
			if (active.current) setBusy(false);
		}
	};
	const move = async (id: string, input: MoveTicket) =>
		mutate(async () => {
			const updated = await api.read(`tickets/${id}/move`, ticketSchema, "POST", input);
			if (!active.current) return;
			setTickets((current) => {
				const values = current.filter((ticket) => ticket.id !== id);
				const index = values.findIndex((ticket) => ticket.id === input.beforeId);
				values.splice(index < 0 ? values.length : index, 0, updated);
				return values;
			});
			setNotice(`${id} moved to ${labels[updated.status]}.`);
		});

	const view = search.get("view") === "backlog" ? "backlog" : "board";
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
		rememberFocus();
		const next = new URLSearchParams(search);
		next.set("ticket", ticket.id);
		next.delete("epic");
		setSearch(next);
	};
	const create = () => {
		rememberFocus();
		setInitialEpic(null);
		setCreating(true);
	};
	const createInEpic = (id: string) => {
		rememberFocus();
		setInitialEpic(id);
		setCreating(true);
		closeEpic();
	};
	const refresh = () => {
		setLoading(true);
		setError("");
		load();
	};
	const selectView = (name: string, focus = false) => {
		const next = new URLSearchParams(search);
		if (name === "backlog") next.set("view", name);
		else next.delete("view");
		setSearch(next);
		if (focus) document.getElementById(`tasks-tab-${name}`)?.focus();
	};
	return (
		<div className='tasks'>
			<div role='tablist' aria-label='Task views' className='ticket-details-tabs tasks-tabs'>
				{(["board", "backlog"] as const).map((name, index) => (
					<button
						key={name}
						type='button'
						role='tab'
						id={`tasks-tab-${name}`}
						aria-controls={`tasks-panel-${name}`}
						aria-selected={view === name}
						tabIndex={view === name ? 0 : -1}
						onClick={() => selectView(name)}
						onKeyDown={(event) => {
							const next = { ArrowLeft: 1 - index, ArrowRight: 1 - index, Home: 0, End: 1 }[event.key];
							if (next === undefined) return;
							event.preventDefault();
							selectView(next === 0 ? "board" : "backlog", true);
						}}
					>
						{name === "board" ? "Board" : "Backlog"}
					</button>
				))}
			</div>
			{(["board", "backlog"] as const).map((name) => (
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
						&& (name === "board" ? (
							<TaskBoard
								tickets={tickets}
								busy={busy}
								loading={loading}
								error={error}
								notice={notice}
								open={open}
								create={create}
								refresh={refresh}
								settings={() => setShowSettings(true)}
								move={move}
								reportError={setError}
							/>
						) : (
							<TaskBacklog
								epics={epics}
								collapsed={collapsed}
								toggleEpic={toggleEpic}
								openEpic={openEpic}
								createEpic={() => {
									rememberFocus();
									setCreatingEpic(true);
								}}
								createInEpic={createInEpic}
								tickets={tickets}
								busy={busy}
								loading={loading}
								error={error}
								notice={notice}
								open={open}
								create={create}
								refresh={refresh}
							/>
						))}
				</div>
			))}
			{showSettings && <BoardSettingsDialog api={api} close={() => setShowSettings(false)} />}
			{linkedId && linked?.id !== linkedId && <p role='status'>Loading ticket…</p>}
			{linkedId && linked?.id === linkedId && linked.error && (
				<p role='alert'>
					{linked.error}
					<button onClick={closeTicket}>Close ticket</button>
				</p>
			)}
			{visible && selectedTicket && (
				<TicketDetails
					epics={epics}
					key={selectedTicket.id}
					ticket={
						selectedTicket.archivedAt
							? selectedTicket
							: (tickets.find((ticket) => ticket.id === selectedTicket.id) ?? selectedTicket)
					}
					api={api}
					busy={busy}
					drafts={drafts}
					reading={reading}
					close={closeTicket}
					archive={() =>
						mutate(async () => {
							await api.read(`tickets/${selectedTicket.id}/archive`, ticketSchema, "POST");
							if (!active.current) return;
							setTickets((current) => current.filter((ticket) => ticket.id !== selectedTicket.id));
							closeTicket();
							setNotice(`${selectedTicket.id} archived.`);
						})
					}
					move={move}
					refreshBoard={() => poller.current?.refresh()}
					save={(input) =>
						mutate(async () => {
							const updated = await api.read(
								`tickets/${selectedTicket.id}`,
								ticketSchema,
								"PATCH",
								input,
							);
							setTickets((current) =>
								current.map((ticket) => (ticket.id === updated.id ? updated : ticket)),
							);
							closeTicket();
						})
					}
				/>
			)}
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
							if (active.current) {
								setTickets((current) => [...current, updated]);
								setNotice(`${updated.id} saved.`);
							}
						})
					}
				/>
			)}
			{visible
				&& (creatingEpic || epicLink)
				&& !creating
				&& !linkedId
				&& (() => {
					const epic = epics.find((value) => value.id === epicLink);
					if (!creatingEpic && !epic)
						return (
							<p role='alert'>
								{error || (loading ? "Loading epic…" : "Epic unavailable.")}{" "}
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
										setCreatingEpic(false);
										openEpic(saved.id);
									}
								})
							}
						/>
					);
				})()}
		</div>
	);
};
