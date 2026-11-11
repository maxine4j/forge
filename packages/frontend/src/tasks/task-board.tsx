import {
	createTicketSchema,
	ticketSchema,
	ticketsSchema,
	ticketStatuses,
	type CreateTicket,
	type MoveTicket,
	type Ticket,
	type TicketStatus,
} from "@forge/contracts/tickets";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, PointerEvent } from "react";

import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { BoardSettingsDialog } from "./board-settings-dialog.tsx";
import { TicketDetails, ticketLabels } from "./ticket-details.tsx";

const labels = ticketLabels;
type Drop = { status: TicketStatus; beforeId?: string };
type Drag = { ticket: Ticket; x: number; y: number; drop?: Drop };

const TicketEditor = ({
	busy,
	close,
	save,
}: {
	busy: boolean;
	close: () => void;
	save: (input: CreateTicket) => Promise<void>;
}) => {
	const dialog = useRef<HTMLDialogElement>(null);
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [error, setError] = useState("");
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	const submit = async (event: FormEvent) => {
		event.preventDefault();
		const input = createTicketSchema.safeParse({ title, description });
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

export const TaskBoard = ({ projectId, api }: { projectId: string; api: IWorkspaceApi }) => {
	const [tickets, setTickets] = useState<Ticket[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [editing, setEditing] = useState<Ticket | "new">();
	const [showSettings, setShowSettings] = useState(false);
	const [drag, setDrag] = useState<Drag>();
	const dragging = useRef<Drag | undefined>(undefined);
	const board = useRef<HTMLDivElement>(null);
	const active = useRef(true);
	const locked = useRef(false);
	const [drafts] = useState(() => new Map<string, string>());
	const poller = useRef<ResourcePoller<Ticket[]> | undefined>(undefined);
	const load = () => poller.current?.refresh();
	useEffect(() => {
		active.current = true;
		const polling = new ResourcePoller(
			() => api.read(`projects/${projectId}/tickets`, ticketsSchema),
			(values) => {
				setTickets(values);
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
	}, [api, projectId]);
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
					return await api.read(`projects/${projectId}/tickets`, ticketsSchema);
				} catch (error) {
					failure = error;
					throw error;
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
	const locate = useCallback((x: number, y: number, id: string): Drop | undefined => {
		const element = document.elementFromPoint(x, y);
		const column = element?.closest<HTMLElement>("[data-drop-status]");
		if (!column || !board.current?.contains(column)) return;
		const status = column.dataset["dropStatus"] as TicketStatus;
		const source = dragging.current?.ticket.status;
		if (source !== status && !(source === "backlog" && status === "todo")) return;
		const cards = [...column.querySelectorAll<HTMLElement>("[data-ticket-id]")].filter(
			(card) => card.dataset["ticketId"] !== id,
		);
		const before = cards.find(
			(card) => y < card.getBoundingClientRect().top + card.getBoundingClientRect().height / 2,
		);
		return { status, ...(before ? { beforeId: before.dataset["ticketId"]! } : {}) };
	}, []);
	const cancelDrag = useCallback(() => {
		dragging.current = undefined;
		setDrag(undefined);
	}, []);
	useEffect(() => {
		if (!drag?.ticket.id) return;
		let frame: number;
		const scroll = () => {
			const current = dragging.current;
			const container = board.current;
			if (!current || !container) return;
			const bounds = container.getBoundingClientRect();
			const speed = (point: number, start: number, end: number) =>
				point < start + 40 ? -10 : point > end - 40 ? 10 : 0;
			if (
				current.y >= bounds.top
				&& current.y <= bounds.bottom
				&& current.x >= bounds.left
				&& current.x <= bounds.right
			) {
				container.scrollBy(speed(current.x, bounds.left, bounds.right), 0);
				const column = document
					.elementFromPoint(current.x, current.y)
					?.closest<HTMLElement>("[data-drop-status]");
				if (column) {
					const rect = column.getBoundingClientRect();
					column.scrollBy(0, speed(current.y, rect.top + 45, rect.bottom));
				}
			}
			const drop = locate(current.x, current.y, current.ticket.id);
			if (drop?.status !== current.drop?.status || drop?.beforeId !== current.drop?.beforeId) {
				dragging.current = { ...current, drop };
				setDrag(dragging.current);
			}
			frame = requestAnimationFrame(scroll);
		};
		frame = requestAnimationFrame(scroll);
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") cancelDrag();
		};
		window.addEventListener("keydown", escape);
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("keydown", escape);
		};
	}, [drag?.ticket.id, locate, cancelDrag]);
	const startDrag = (event: PointerEvent<HTMLButtonElement>, ticket: Ticket) => {
		if (busy || loading || event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragging.current = { ticket, x: event.clientX, y: event.clientY };
		setDrag(dragging.current);
	};
	const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
		const current = dragging.current;
		if (!current) return;
		dragging.current = {
			...current,
			x: event.clientX,
			y: event.clientY,
			drop: locate(event.clientX, event.clientY, current.ticket.id),
		};
		setDrag(dragging.current);
	};
	const finishDrag = (event: PointerEvent<HTMLButtonElement>) => {
		const current = dragging.current;
		const drop = current && locate(event.clientX, event.clientY, current.ticket.id);
		cancelDrag();
		if (current && drop)
			void move(current.ticket.id, drop).catch((failure: unknown) => {
				if (active.current) setError(failure instanceof Error ? failure.message : "Cannot move ticket. Retry.");
			});
	};
	return (
		<div className={`task-board ${drag ? "is-dragging" : ""}`}>
			<div className='task-board-heading'>
				<div>
					<h2>Board</h2>
				</div>
				<div className='task-board-actions'>
					<button type='button' disabled={!!drag} onClick={() => setShowSettings(true)}>
						Board settings
					</button>
					<button
						disabled={busy || loading || !!drag}
						onClick={() => {
							setLoading(true);
							setError("");
							void load();
						}}
					>
						Refresh board
					</button>
					<button className='primary' disabled={busy || loading || !!drag} onClick={() => setEditing("new")}>
						Create ticket
					</button>
				</div>
			</div>
			{error && (
				<p role='alert' className='error'>
					{error}
				</p>
			)}
			<p className='board-feedback' role='status'>
				{loading
					? "Loading tickets…"
					: notice || "Drag by the grip to move tickets, or open a ticket to change its status."}
			</p>
			<div ref={board} className='kanban-columns' aria-label='Ticket board' aria-busy={busy || loading}>
				{ticketStatuses.map((status) => {
					const values = tickets.filter((ticket) => ticket.status === status);
					return (
						<section
							key={status}
							className={`kanban-column ${drag?.drop?.status === status ? "is-drop-target" : ""}`}
							data-drop-status={status}
							aria-label={labels[status]}
						>
							<div className='kanban-column-heading'>
								<h3>{labels[status]}</h3>
								<span className='kanban-count'>{values.length}</span>
							</div>
							<div className='kanban-cards'>
								{values.map((ticket) => (
									<Fragment key={ticket.id}>
										{drag?.drop?.status === status && drag.drop.beforeId === ticket.id && (
											<div className='ticket-drop-placeholder' aria-hidden='true' />
										)}
										<article
											className={`ticket-card ${ticket.needsAttention ? "needs-attention" : ""} ${drag?.ticket.id === ticket.id ? "is-drag-source" : ""}`}
											data-ticket-id={ticket.id}
										>
											<button
												className='ticket-open'
												aria-label={`${ticket.id} ${ticket.title}`}
												disabled={busy || !!drag}
												onClick={() => setEditing(ticket)}
											>
												<span className='ticket-title'>{ticket.title}</span>
												<span className='ticket-key'>
													<span
														className={`ticket-type ${status === "done" ? "ticket-complete" : ""}`}
														aria-hidden='true'
													>
														✓
													</span>
													{ticket.id}
												</span>
												{ticket.needsAttention ? (
													<span
														className='ticket-agent-status ticket-attention'
														role='img'
														aria-label='Action required'
														title='Action required'
													/>
												) : ticket.agentStatus ? (
													<svg
														className={`ticket-agent-status ${ticket.agentStatus === "working" ? "is-working" : ""}`}
														role='img'
														aria-label={
															ticket.agentStatus === "queued"
																? "Agent queued"
																: "Agent working"
														}
														viewBox='0 0 16 16'
														fill='none'
														stroke='currentColor'
														strokeWidth='1.5'
													>
														<title>
															{ticket.agentStatus === "queued"
																? "Agent queued"
																: "Agent working"}
														</title>
														{ticket.agentStatus === "queued" ? (
															<>
																<circle cx='8' cy='8' r='6' />
																<path d='M8 4v4l3 2' />
															</>
														) : (
															<path d='M8 2a6 6 0 1 1-6 6' strokeLinecap='round' />
														)}
													</svg>
												) : null}
											</button>
											<button
												className='ticket-drag-handle'
												aria-label={`Drag ${ticket.id}`}
												title='Drag to move; open ticket for status menu'
												disabled={busy}
												onPointerDown={(event) => startDrag(event, ticket)}
												onPointerMove={pointerMove}
												onPointerUp={finishDrag}
												onPointerCancel={cancelDrag}
												onLostPointerCapture={cancelDrag}
											>
												⠿
											</button>
										</article>
									</Fragment>
								))}
								{drag?.drop?.status === status && !drag.drop.beforeId && (
									<div className='ticket-drop-placeholder' aria-hidden='true' />
								)}
								{!values.length && (
									<p className='kanban-empty'>{drag ? "Drop ticket here" : "No tickets"}</p>
								)}
							</div>
						</section>
					);
				})}
			</div>
			{drag && (
				<>
					<style>{`.ticket-drag-preview { left: ${Math.round(drag.x + 14)}px; top: ${Math.round(drag.y + 14)}px; }`}</style>
					<div className='ticket-drag-preview' aria-hidden='true'>
						<span className='ticket-title'>{drag.ticket.title}</span>
						<span className='ticket-key'>{drag.ticket.id}</span>
					</div>
				</>
			)}
			{showSettings && <BoardSettingsDialog api={api} close={() => setShowSettings(false)} />}
			{editing && editing !== "new" && (
				<TicketDetails
					ticket={tickets.find((ticket) => ticket.id === editing.id) ?? editing}
					api={api}
					busy={busy}
					drafts={drafts}
					close={() => setEditing(undefined)}
					archive={() =>
						mutate(async () => {
							await api.read(`tickets/${editing.id}/archive`, ticketSchema, "POST");
							if (!active.current) return;
							setTickets((current) => current.filter((ticket) => ticket.id !== editing.id));
							setEditing(undefined);
							setNotice(`${editing.id} archived.`);
						})
					}
					move={move}
					refreshBoard={() => poller.current?.refresh()}
					save={(input) =>
						mutate(async () => {
							const updated = await api.read(`tickets/${editing.id}`, ticketSchema, "PATCH", input);
							setTickets((current) =>
								current.map((ticket) => (ticket.id === updated.id ? updated : ticket)),
							);
							setEditing(undefined);
						})
					}
				/>
			)}
			{editing === "new" && (
				<TicketEditor
					key='new'
					busy={busy}
					close={() => setEditing(undefined)}
					save={(input) =>
						mutate(async () => {
							const updated = await api.read(
								`projects/${projectId}/tickets`,
								ticketSchema,
								"POST",
								input,
							);
							if (active.current) {
								setTickets((current) => [...current, updated]);
								setNotice(`${updated.id} saved.`);
							}
						})
					}
				/>
			)}
		</div>
	);
};
