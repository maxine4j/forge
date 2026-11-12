import { costsSchema, type Costs } from "@forge/contracts";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { CostMetrics, Money, PhaseCosts, WeeklyUsage, formatPercent } from "./cost-metrics.tsx";
import { WeeklyBudgetChart } from "./weekly-budget.tsx";

const number = new Intl.NumberFormat("en-AU");
const shortNumber = new Intl.NumberFormat("en-AU", { notation: "compact" });
const day = new Intl.DateTimeFormat("en-AU", { month: "short", day: "numeric", timeZone: "UTC" });
const resetTime = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" });
const tokens = (value: { input: number; output: number }) => value.input + value.output;
const phaseLabels = {
	planning: "Planning",
	implementation: "Implementation",
	review: "Review",
	rebase: "Rebase",
	chat: "Standalone chats",
};

const TokenStack = ({ counts, scale }: { counts: Costs["days"][number]; scale: number }) => (
	<span className='cost-day-stack'>
		<span className='cost-uncached' style={{ height: `${(100 * (counts.input - counts.cached)) / scale}%` }} />
		<span className='cost-cached' style={{ height: `${(100 * counts.cached) / scale}%` }} />
		<span className='cost-output' style={{ height: `${(100 * counts.output) / scale}%` }} />
	</span>
);

const UsageCharts = ({ cost }: { cost: Costs }) => {
	const [range, setRange] = useState(30);
	const days = cost.days.slice(-range);
	const scale = Math.max(1, ...days.map(tokens));
	const phaseScale = Math.max(1, ...cost.phases.map(tokens));
	return (
		<div className='cost-charts'>
			<section className='cost-card'>
				<header className='cost-heading'>
					<h3>Token usage over time</h3>
					<select
						aria-label='Usage period'
						value={range}
						onChange={(event) => setRange(Number(event.target.value))}
					>
						<option value={7}>Last 7 days</option>
						<option value={30}>Last 30 days</option>
					</select>
				</header>
				{days.every((entry) => tokens(entry) === 0) ? (
					<p className='cost-muted'>No tokens recorded in this period.</p>
				) : (
					<>
						<div className='cost-trend' role='img' aria-label='Daily token usage'>
							<div className='cost-axis'>
								<span>{shortNumber.format(scale)}</span>
								<span>0</span>
							</div>
							<div className='cost-days'>
								{days.map((entry) => (
									<div
										className='cost-day'
										key={entry.date}
										title={`${day.format(new Date(entry.date))} · ${number.format(tokens(entry))} tokens`}
									>
										<TokenStack counts={entry} scale={scale} />
									</div>
								))}
							</div>
						</div>
						<div className='cost-dates'>
							{[days.at(0), days.at(-1)].map(
								(entry, index) => entry && <span key={index}>{day.format(new Date(entry.date))}</span>,
							)}
						</div>
						<ul className='cost-legend' aria-label='Token types'>
							<li>
								<span className='cost-uncached' />
								Input
							</li>
							<li>
								<span className='cost-cached' />
								Cached input
							</li>
							<li>
								<span className='cost-output' />
								Output
							</li>
						</ul>
						<details className='cost-daily-details'>
							<summary>Daily values (UTC)</summary>
							<ul>
								{days.map((entry) => (
									<li key={entry.date}>
										<time dateTime={entry.date}>{day.format(new Date(entry.date))}</time>{" "}
										<span>{number.format(tokens(entry))} tokens</span>
									</li>
								))}
							</ul>
						</details>
					</>
				)}
			</section>
			<section className='cost-card'>
				<h3>Tokens by phase</h3>
				{!cost.phases.length ? (
					<p className='cost-muted'>No phase usage recorded yet.</p>
				) : (
					<div
						className='cost-phases'
						role='img'
						aria-label='Tokens by phase'
						aria-description={cost.phases
							.map((entry) => `${phaseLabels[entry.phase]} ${number.format(tokens(entry))}`)
							.join(", ")}
					>
						{cost.phases.map((entry) => (
							<div className='cost-phase' key={entry.phase}>
								<div>
									<span>{phaseLabels[entry.phase]}</span>
									<strong>{number.format(tokens(entry))}</strong>
								</div>
								<span className='cost-bar' aria-hidden='true'>
									<span style={{ width: `${(100 * tokens(entry)) / phaseScale}%` }} />
								</span>
							</div>
						))}
					</div>
				)}
			</section>
		</div>
	);
};

const Quotas = ({ limits }: { limits: Costs["limits"] }) => (
	<section className='cost-card cost-quotas'>
		<header className='cost-heading'>
			<h3>Codex account limits</h3>
			{limits?.plan && <span className='cost-plan'>{limits.plan}</span>}
		</header>
		{!limits?.windows.length ? (
			<p className='cost-muted'>Codex hasn’t reported any usage windows.</p>
		) : (
			<div className='cost-quota-grid'>
				{limits.windows.map((window, index) => {
					const label =
						window.minutes === 300
							? "5-hour window"
							: window.minutes === 10080
								? "Weekly window"
								: window.minutes
									? `${number.format(window.minutes)}-minute window`
									: "Usage window";
					return (
						<div className='cost-phase' key={index}>
							<div>
								<span>
									{label} <small>{window.bucket}</small>
								</span>
								<strong>{formatPercent(window.usedPercent)} used</strong>
							</div>
							<progress
								max={100}
								value={Math.min(100, window.usedPercent)}
								aria-label={`${window.bucket} ${label}`}
							/>
							{window.resetsAt && <small>Resets {resetTime.format(new Date(window.resetsAt))}</small>}
						</div>
					);
				})}
			</div>
		)}
	</section>
);

const TicketCosts = ({ cost }: { cost: Costs }) => {
	const [sort, setSort] = useState("tokens");
	const tickets = [...cost.tickets].sort((a, b) =>
		sort === "ticket"
			? a.id.localeCompare(b.id, undefined, { numeric: true })
			: (sort === "api"
					? (b.apiUsd ?? -1)
					: sort === "weekly"
						? (b.weeklyUsagePercent ?? -1)
						: sort === "effective"
							? (b.effectiveUsd ?? -1)
							: tokens(b))
				- (sort === "api"
					? (a.apiUsd ?? -1)
					: sort === "weekly"
						? (a.weeklyUsagePercent ?? -1)
						: sort === "effective"
							? (a.effectiveUsd ?? -1)
							: tokens(a)),
	);
	return (
		<section className='cost-card'>
			<h3>Usage and cost by ticket</h3>
			<label>
				Sort tickets
				<select value={sort} onChange={(event) => setSort(event.target.value)}>
					<option value='ticket'>Ticket</option>
					<option value='tokens'>Tokens</option>
					<option value='api'>Estimated API cost</option>
					<option value='weekly'>Weekly limit spent</option>
					<option value='effective'>Effective cost</option>
				</select>
			</label>
			{!tickets.length ? (
				<p>No tickets yet.</p>
			) : (
				<div className='cost-table-scroll' role='region' aria-label='Ticket costs' tabIndex={0}>
					<table className='cost-table'>
						<thead>
							<tr>
								<th>Ticket</th>
								<th>Tokens</th>
								<th>Estimated API cost</th>
								<th>Weekly limit spent (estimate)</th>
								<th>Effective cost (estimate)</th>
							</tr>
						</thead>
						<tbody>
							{tickets.map((ticket) => (
								<tr key={ticket.id}>
									<th>
										<Link to={`/tasks?ticket=${encodeURIComponent(ticket.id)}`}>
											{ticket.id} {ticket.title}
										</Link>
										{ticket.archivedAt && <small>Archived</small>}
										<details>
											<summary>Phase breakdown</summary>
											<PhaseCosts phases={ticket.phases} />
										</details>
									</th>
									<td>{number.format(tokens(ticket))}</td>
									<td>
										<Money summary={ticket} metric='api' />
									</td>
									<td>
										<WeeklyUsage summary={ticket} />
									</td>
									<td>
										<Money summary={ticket} metric='effective' />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
};

export const CostDashboard = ({ api }: { api: IWorkspaceApi }) => {
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const timer = window.setInterval(() => setAttempt((value) => value + 1), 300_000);
		return () => window.clearInterval(timer);
	}, []);
	const [result, setResult] = useState<{ attempt: number; value?: Costs }>();
	useEffect(() => {
		let current = true;
		void api.read("costs", costsSchema).then(
			(value) => {
				if (current) setResult({ attempt, value });
			},
			() => {
				if (current) setResult({ attempt });
			},
		);
		return () => {
			current = false;
		};
	}, [api, attempt]);
	const cost = result?.value;
	const pending = result?.attempt !== attempt;
	return (
		<div className='cost-dashboard' aria-busy={pending}>
			<header className='cost-heading cost-title'>
				<div>
					<h2>Costs</h2>
					{cost && <p className='cost-muted'>Recorded since {cost.since.slice(0, 10)} (UTC)</p>}
				</div>
				{cost && (
					<button disabled={pending} onClick={() => setAttempt((value) => value + 1)}>
						Refresh
					</button>
				)}
			</header>
			{pending && !cost && <p role='status'>Loading cost data…</p>}
			{!pending && !cost && (
				<div className='cost-card'>
					<p role='alert'>Cost data is unavailable.</p>
					<button onClick={() => setAttempt((value) => value + 1)}>Retry</button>
				</div>
			)}
			{cost && (
				<>
					<h3>Ticket totals</h3>
					<CostMetrics summary={cost.ticketEstimates} />
					<details>
						<summary>Account usage including standalone chats</summary>
						<CostMetrics summary={cost.totals} />
						<PhaseCosts phases={cost.phases} />
						<p>
							Total tokens: {number.format(tokens(cost.totals))}; input:{" "}
							{number.format(cost.totals.input)}; cached: {number.format(cost.totals.cached)}; output:{" "}
							{number.format(cost.totals.output)}; turns: {cost.totals.turns}
						</p>
					</details>
					<details>
						<summary>Standalone chats</summary>
						<CostMetrics summary={cost.chats} />
					</details>
					{cost.quotaAttribution.map((bucket) => (
						<p key={bucket.bucketId}>
							{bucket.bucketId}: observed {formatPercent(bucket.consumption)}, allocated{" "}
							{formatPercent(bucket.allocated)}, unallocated {formatPercent(bucket.unallocated)}
						</p>
					))}
					<WeeklyBudgetChart budget={cost.weeklyBudget} />
					<UsageCharts cost={cost} />
					<Quotas limits={cost.limits} />
					<TicketCosts cost={cost} />
				</>
			)}
		</div>
	);
};
