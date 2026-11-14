import type { EpicSummary, Ticket } from "@forge/contracts/tickets";

import { compareBacklogTickets } from "./backlog-sort.ts";
import { TicketIndicator } from "./ticket-indicator.tsx";
import { ticketLabels } from "./ticket-labels.ts";

export const EpicProgress = ({ done, total }: Pick<EpicSummary, "done" | "total">) => {
	const label = `${done} / ${total} done`;
	return (
		<span
			className='epic-progress'
			role='progressbar'
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={total || 1}
			aria-valuenow={done}
			aria-valuetext={label}
			title={label}
		>
			<svg className='epic-progress-ring' viewBox='0 0 20 20' aria-hidden='true'>
				<circle className='epic-progress-track' cx='10' cy='10' r='8' />
				<circle
					className='epic-progress-completion'
					cx='10'
					cy='10'
					r='8'
					pathLength='100'
					strokeDasharray={`${total ? (done / total) * 100 : 0} 100`}
				/>
			</svg>
			<progress value={done} max={total || 1} aria-hidden='true' />
			<span aria-hidden='true'>{label}</span>
		</span>
	);
};

export const TicketTable = ({
	tickets,
	labelId,
	id,
	hidden,
	busy,
	open,
	emptyMessage,
}: {
	tickets: Ticket[];
	labelId: string;
	id?: string;
	hidden?: boolean;
	busy: boolean;
	open: (ticket: Ticket) => void;
	emptyMessage?: string;
}) => (
	<table className='backlog-table' id={id} aria-labelledby={labelId} hidden={hidden}>
		<colgroup>
			<col className='backlog-key-column' />
			<col />
			<col className='backlog-status-column' />
		</colgroup>
		<tbody>
			{tickets.toSorted(compareBacklogTickets).map((ticket) => (
				<tr key={ticket.id} className={ticket.needsAttention ? "needs-attention" : ""}>
					<td>
						<button
							className='backlog-open'
							disabled={busy}
							aria-label={`${ticket.id} ${ticket.title}`}
							title={ticket.title}
							onClick={() => open(ticket)}
						>
							<span
								className={`ticket-type ${ticket.status === "done" ? "ticket-complete" : ""}`}
								aria-hidden='true'
							>
								✓
							</span>
							{ticket.id}
						</button>
					</td>
					<td className='backlog-title'>
						<div className='backlog-title-content'>
							<span className='backlog-title-text' title={ticket.title}>
								{ticket.title}
							</span>
							<TicketIndicator ticket={ticket} />
						</div>
					</td>
					<td>
						<span
							className={`backlog-status ticket-status-${ticket.status}`}
							title={ticketLabels[ticket.status]}
						>
							{ticketLabels[ticket.status]}
						</span>
					</td>
				</tr>
			))}
			{!tickets.length && emptyMessage && (
				<tr>
					<td colSpan={3}>{emptyMessage}</td>
				</tr>
			)}
		</tbody>
	</table>
);
