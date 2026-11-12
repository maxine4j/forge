import { ticketCostSchema, type TicketCost as TicketCostData } from "@forge/contracts";
import { useEffect, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { formatAud } from "../cost/cost-dashboard.tsx";

const number = new Intl.NumberFormat("en-AU");
const missingTurns = (count: number, field: string) =>
	count > 0 && (
		<small className='cost-muted'>
			{count} {count === 1 ? "turn" : "turns"} missing {field}
		</small>
	);

export const TicketCost = ({ api, ticketId }: { api: IWorkspaceApi; ticketId: string }) => {
	const [attempt, setAttempt] = useState(0);
	const [cost, setCost] = useState<TicketCostData | "unavailable">();
	useEffect(() => {
		let current = true;
		void api.read(`tickets/${ticketId}/cost`, ticketCostSchema).then(
			(value) => {
				if (current) setCost(value);
			},
			() => {
				if (current) setCost("unavailable");
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
						setCost(undefined);
						setAttempt((value) => value + 1);
					}}
				>
					Retry
				</button>
			</div>
		);
	const ticket = cost.ticket;
	if (!ticket?.turns) return <p>No usage recorded for this ticket.</p>;
	return (
		<div className='cost-dashboard'>
			<dl className='cost-metrics'>
				<div className='cost-card'>
					<dt>Subscription allocation</dt>
					<dd>
						<span>{formatAud(ticket.subscriptionAud)}</span>
						{missingTurns(ticket.untimedTurns, "duration")}
					</dd>
				</div>
				<div className='cost-card'>
					<dt>API equivalent</dt>
					<dd>
						<span>{formatAud(ticket.apiAud)}</span>
						{missingTurns(ticket.unpricedTurns, "pricing")}
					</dd>
				</div>
			</dl>
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
