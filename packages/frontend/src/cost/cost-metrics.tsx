import type { CostSummary, TicketCost } from "@forge/contracts";

const money = (value: number | undefined, currency: string) =>
	value === undefined
		? "—"
		: new Intl.NumberFormat("en-AU", {
				style: "currency",
				currency,
				currencyDisplay: "narrowSymbol",
				minimumFractionDigits: 2,
				maximumFractionDigits: 4,
			}).format(value);
export const formatPercent = (value?: number) =>
	value === undefined
		? "—"
		: `${new Intl.NumberFormat("en-AU", { minimumSignificantDigits: 3, maximumSignificantDigits: 3 }).format(value)}%`;
export const Money = ({ summary, metric }: { summary: CostSummary; metric: "api" | "effective" }) => (
	<>
		{summary.localCurrencies.map((local) => (
			<span key={local.currency}>
				{local.currency} {money(local[metric], local.currency)}
				{local.incomplete > 0 && " (conversion incomplete)"}
				<br />
			</span>
		))}
		<small>USD {money(summary[metric === "api" ? "apiUsd" : "effectiveUsd"], "USD")}</small>
		{summary.incomplete[metric] > 0 && (
			<small>
				Partial / unavailable: {summary.incomplete[metric]}{" "}
				{summary.incomplete[metric] === 1 ? "turn" : "turns"} missing{" "}
				{metric === "api" ? "pricing or usage" : "quota attribution or conversion"}
			</small>
		)}
	</>
);
export const WeeklyUsage = ({ summary }: { summary: CostSummary }) => (
	<>
		{summary.weeklyBuckets.length > 1
			? summary.weeklyBuckets.map((bucket) => (
					<span key={bucket.bucketId}>
						{bucket.bucketId}: {formatPercent(bucket.percent)}
						<br />
					</span>
				))
			: formatPercent(summary.weeklyUsagePercent)}
		{summary.incomplete.weekly > 0 && <small>Partial / unavailable quota attribution</small>}
	</>
);
export const CostMetrics = ({ summary }: { summary: CostSummary }) => (
	<>
		<dl className='cost-metrics'>
			<div className='cost-card'>
				<dt>Estimated API cost</dt>
				<dd>
					<Money summary={summary} metric='api' />
				</dd>
			</div>
			<div className='cost-card'>
				<dt>Weekly limit spent (estimate)</dt>
				<dd>
					<WeeklyUsage summary={summary} />
				</dd>
			</div>
			<div className='cost-card'>
				<dt>Effective cost (estimate)</dt>
				<dd>
					<Money summary={summary} metric='effective' />
				</dd>
			</div>
		</dl>
		<p className='cost-muted'>
			Quota attribution and effective costs are estimates. Account counters include external activity and delayed
			updates. Historical local amounts use each turn’s saved exchange rate. Effective cost uses the saved monthly
			plan price divided by 4.33.
		</p>
	</>
);
export const PhaseCosts = ({ phases }: { phases: TicketCost["phases"] }) => (
	<div className='cost-table-scroll'>
		<table className='cost-table'>
			<caption>Cost by phase</caption>
			<thead>
				<tr>
					<th>Phase</th>
					<th>Estimated API cost</th>
					<th>Weekly limit spent (estimate)</th>
					<th>Effective cost (estimate)</th>
					<th>Tokens / turns</th>
				</tr>
			</thead>
			<tbody>
				{phases.map((phase) => (
					<tr key={phase.phase}>
						<th>{phase.phase}</th>
						<td>
							<Money summary={phase} metric='api' />
						</td>
						<td>
							<WeeklyUsage summary={phase} />
						</td>
						<td>
							<Money summary={phase} metric='effective' />
						</td>
						<td>
							{phase.input + phase.output} / {phase.turns}
							{phase.incomplete.tokens > 0 && <small>Incomplete token usage</small>}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	</div>
);
