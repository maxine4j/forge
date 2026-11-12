import { ticketStatuses, type Ticket, type TicketStatus, type MoveTicket } from "@forge/contracts/tickets";
import { Fragment, useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

import { ticketLabels as labels } from "./ticket-details.tsx";
import { TicketIndicator } from "./ticket-indicator.tsx";
type Drop = { status: TicketStatus; beforeId?: string };
type Drag = { ticket: Ticket; x: number; y: number; drop?: Drop };
export type TaskViewProps = {
	tickets: Ticket[];
	busy: boolean;
	loading: boolean;
	error: string;
	notice: string;
	open: (ticket: Ticket) => void;
	create: () => void;
	refresh: () => void;
};
export const TaskBoard = ({
	tickets,
	busy,
	loading,
	error,
	notice,
	open,
	create,
	refresh,
	settings,
	move,
	reportError,
}: TaskViewProps & {
	settings: () => void;
	move: (id: string, input: MoveTicket) => Promise<void>;
	reportError: (error: string) => void;
}) => {
	const [drag, setDrag] = useState<Drag>();
	const dragging = useRef<Drag | undefined>(undefined);
	const board = useRef<HTMLDivElement>(null);
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
				reportError(failure instanceof Error ? failure.message : "Cannot move ticket. Retry.");
			});
	};
	return (
		<div className={`task-board ${drag ? "is-dragging" : ""}`}>
			<div className='task-board-heading'>
				<div>
					<h2>Board</h2>
				</div>
				<div className='task-board-actions'>
					<button type='button' disabled={!!drag} onClick={settings}>
						Board settings
					</button>
					<button disabled={busy || loading || !!drag} onClick={refresh}>
						Refresh board
					</button>
					<button className='primary' disabled={busy || loading || !!drag} onClick={create}>
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
												onClick={() => open(ticket)}
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
												<TicketIndicator ticket={ticket} />
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
		</div>
	);
};
