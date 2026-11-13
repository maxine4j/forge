import type { EpicSummary, Ticket } from "@forge/contracts/tickets";

import { TicketIndicator } from "./ticket-indicator.tsx";
import { ticketLabels } from "./ticket-labels.ts";

export const EpicProgress = ({ done, total }: Pick<EpicSummary, "done" | "total">) => {
	const label = `${done} / ${total} done`;
	return (
		<span className='epic-progress'>
			<progress value={done} max={total || 1} aria-label={label} />
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
			{tickets.map((ticket) => (
				<tr key={ticket.id} className={ticket.needsAttention ? "needs-attention" : ""}>
					<td>
						<button
							className='backlog-open'
							disabled={busy}
							aria-label={`${ticket.id} ${ticket.title}`}
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
						{ticket.title}
						<TicketIndicator ticket={ticket} />
					</td>
					<td>
						<span className={`backlog-status ticket-status-${ticket.status}`}>
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
