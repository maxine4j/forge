import { ticketCostSchema, type TicketCost as TicketCostData } from "@forge/contracts";
import { useEffect, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { CostMetrics, PhaseCosts } from "../cost/cost-metrics.tsx";

const number = new Intl.NumberFormat("en-AU");
export const TicketCost = ({ api, ticketId }: { api: IWorkspaceApi; ticketId: string }) => {
	const [attempt, setAttempt] = useState(0);
	const [result, setResult] = useState<{ ticketId: string; value: TicketCostData | "unavailable" }>();
	const cost = result?.ticketId === ticketId ? result.value : undefined;
	useEffect(() => {
		let current = true;
		void api.read(`tickets/${ticketId}/cost`, ticketCostSchema).then(
			(value) => {
				if (current) setResult({ ticketId, value });
			},
			() => {
				if (current) setResult({ ticketId, value: "unavailable" });
			},
		);
		return () => {
			current = false;
		};
	}, [api, ticketId, attempt]);
	if (!cost) return <p role='status'>Loading cost data…</p>;
	if (cost === "unavailable")
		return (
			<div className='cost-card'>
				<p role='alert'>Cost data is unavailable.</p>
				<button
					type='button'
					onClick={() => {
						setResult(undefined);
						setAttempt((value) => value + 1);
					}}
				>
					Retry
				</button>
			</div>
		);
	const ticket = cost.ticket;

	return (
		<div className='cost-dashboard'>
			{!ticket.turns && <p>No usage recorded for this ticket.</p>}
			<button onClick={() => setAttempt((value) => value + 1)}>Refresh</button>
			<CostMetrics summary={ticket} />
			<PhaseCosts phases={cost.phases} />
			{ticket.incomplete.tokens > 0 && (
				<p>Partial token counts: {ticket.incomplete.tokens} turns missing usage.</p>
			)}
			<dl className='cost-metrics'>
				{Object.entries({
					"Total tokens": ticket.input + ticket.output,
					"Input tokens": ticket.input,
					"Cached input tokens": ticket.cached,
					"Output tokens": ticket.output,
					Turns: ticket.turns,
				}).map(([label, value]) => (
					<div className='cost-card' key={label}>
						<dt>{label}</dt>
						<dd>{number.format(value)}</dd>
					</div>
				))}
			</dl>
			<p className='cost-muted'>Recorded since {cost.since.slice(0, 10)} (UTC)</p>
		</div>
	);
};
