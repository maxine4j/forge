import {
	costRangeSchema,
	defaultCostRange,
	ticketCostSchema,
	type TicketCost as TicketCostData,
} from "@forge/contracts";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { CostMetrics, PhaseCosts } from "../cost/cost-metrics.tsx";
import { useToast } from "../toasts/toasts.tsx";

const number = new Intl.NumberFormat("en-AU");
export const TicketCost = ({ api, ticketId }: { api: IWorkspaceApi; ticketId: string }) => {
	const { notify } = useToast();
	const [query] = useSearchParams();
	const range = costRangeSchema.safeParse(query.get("range")).data ?? defaultCostRange;
	const [attempt, setAttempt] = useState(0);
	const [result, setResult] = useState<{ ticketId: string; range: string; value: TicketCostData | "unavailable" }>();
	const cost = result?.ticketId === ticketId && result.range === range ? result.value : undefined;
	useEffect(() => {
		let current = true;
		const path = `tickets/${ticketId}/cost`;
		void api.read(range === defaultCostRange ? path : `${path}?range=${range}`, ticketCostSchema).then(
			(value) => {
				if (current) setResult({ ticketId, range, value });
			},
			() => {
				if (current) {
					setResult({ ticketId, range, value: "unavailable" });
					notify("Cost data is unavailable.");
				}
			},
		);
		return () => {
			current = false;
		};
	}, [api, ticketId, attempt, notify, range]);
	if (!cost) return <p role='status'>Loading cost data…</p>;
	if (cost === "unavailable")
		return (
			<div className='cost-card'>
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
			{!ticket.turns && <p>No usage recorded for this ticket in this period.</p>}
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
			<p className='cost-muted'>
				Range {range} · Recorded since {cost.since.slice(0, 10)} (UTC)
			</p>
		</div>
	);
};
