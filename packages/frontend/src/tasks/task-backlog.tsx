import type { TaskViewProps } from "./task-board.tsx";
import { ticketLabels } from "./ticket-details.tsx";
import { TicketIndicator } from "./ticket-indicator.tsx";
export const TaskBacklog = ({ tickets, busy, loading, error, notice, open, create, refresh }: TaskViewProps) => {
	const unfinished = tickets.filter((ticket) => !ticket.archivedAt && ticket.status !== "done");
	return (
		<div className='task-backlog'>
			<div className='task-board-heading'>
				<h2>Backlog</h2>
				<div className='task-board-actions'>
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
					<tbody>
						{unfinished.map((ticket) => (
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
					</tbody>
				</table>
				{!loading && !error && !unfinished.length && (
					<p className='kanban-empty'>No unfinished tickets. Create a ticket to get started.</p>
				)}
			</div>
		</div>
	);
};
