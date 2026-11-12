import type { EpicSummary } from "@forge/contracts/tickets";
import { Fragment } from "react";

import type { TaskViewProps } from "./task-board.tsx";
import { ticketLabels } from "./ticket-details.tsx";
import { TicketIndicator } from "./ticket-indicator.tsx";
export const TaskBacklog = ({
	tickets,
	busy,
	loading,
	error,
	notice,
	open,
	create,
	refresh,
	epics,
	collapsed,
	toggleEpic,
	openEpic,
	createEpic,
	createInEpic,
}: TaskViewProps & {
	epics: EpicSummary[];
	collapsed: string[];
	toggleEpic: (id: string) => void;
	openEpic: (id: string) => void;
	createEpic: () => void;
	createInEpic: (id: string) => void;
}) => {
	const unfinished = tickets.filter((ticket) => !ticket.archivedAt && ticket.status !== "done");
	return (
		<div className='task-backlog'>
			<div className='task-board-heading'>
				<h2>Backlog</h2>
				<div className='task-board-actions'>
					<button disabled={busy || loading} onClick={createEpic}>
						Create epic
					</button>
					<button disabled={busy || loading} onClick={refresh}>
						Refresh
					</button>
					<button className='primary' disabled={busy || loading} onClick={create}>
						Create ticket
					</button>
				</div>
			</div>
			{error && (
				<p role='alert' className='error'>
					{error} Use Refresh to retry.
				</p>
			)}
			<p role='status'>
				{loading ? "Loading tickets…" : `${unfinished.length} unfinished tickets`}
				{notice && ` · ${notice}`}
			</p>
			<div
				className='backlog-scroll'
				role='region'
				aria-label='Unfinished tickets'
				tabIndex={0}
				aria-busy={busy || loading}
			>
				<table className='backlog-table'>
					<caption>Unfinished tickets</caption>
					<thead>
						<tr>
							<th scope='col'>Key</th>
							<th scope='col'>Title</th>
							<th scope='col'>Status</th>
						</tr>
					</thead>
					{[undefined, ...epics].map((epic) => {
						const rows = unfinished.filter((ticket) => (ticket.epicId ?? undefined) === epic?.id);
						const expanded = !epic || !collapsed.includes(epic.id);
						return (
							<Fragment key={epic?.id ?? "none"}>
								<tbody>
									<tr className='epic-heading'>
										<th colSpan={3} scope='colgroup'>
											{epic ? (
												<div className='epic-controls'>
													<button
														aria-expanded={expanded}
														aria-controls={`children-${epic.id}`}
														aria-label={`${expanded ? "Collapse" : "Expand"} ${epic.id}`}
														onClick={() => toggleEpic(epic.id)}
													>
														{expanded ? "▾" : "▸"}
													</button>
													<button onClick={() => openEpic(epic.id)}>
														{epic.id} · {epic.title}
													</button>
													<span>
														{rows.length} unfinished · {epic.done}/{epic.total} Done
														{epic.complete ? " · Complete" : ""}
													</span>
													<button disabled={busy} onClick={() => createInEpic(epic.id)}>
														Create ticket
													</button>
												</div>
											) : (
												"No epic"
											)}
										</th>
									</tr>
								</tbody>
								<tbody id={epic ? `children-${epic.id}` : "children-no-epic"} hidden={!expanded}>
									{rows.map((ticket) => (
										<tr key={ticket.id} className={ticket.needsAttention ? "needs-attention" : ""}>
											<td>
												<button
													className='backlog-open'
													disabled={busy}
													aria-label={`${ticket.id} ${ticket.title}`}
													onClick={() => open(ticket)}
												>
													{ticket.id}
												</button>
											</td>
											<td className='backlog-title'>
												{ticket.title}
												<TicketIndicator ticket={ticket} />
											</td>
											<td>{ticketLabels[ticket.status]}</td>
										</tr>
									))}
									{epic && !rows.length && (
										<tr>
											<td colSpan={3}>No unfinished tickets in this epic.</td>
										</tr>
									)}
								</tbody>
							</Fragment>
						);
					})}
				</table>
				{!loading && !error && !unfinished.length && (
					<p className='kanban-empty'>No unfinished tickets. Create a ticket to get started.</p>
				)}
			</div>
		</div>
	);
};
