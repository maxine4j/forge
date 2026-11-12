import { costsSchema, type Costs } from "@forge/contracts";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { WeeklyBudgetChart } from "./weekly-budget.tsx";

const number = new Intl.NumberFormat("en-AU");
const shortNumber = new Intl.NumberFormat("en-AU", { notation: "compact" });
const amount = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const day = new Intl.DateTimeFormat("en-AU", { month: "short", day: "numeric", timeZone: "UTC" });
const resetTime = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" });
export const formatAud = (value?: number) =>
	value === undefined ? "—" : value > 0 && value < 0.0001 ? "< A$0.0001" : `A$${amount.format(value)}`;
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
								<strong>{window.usedPercent}% used</strong>
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

const columns = { ticket: "Ticket", tokens: "Tokens", subscription: "Subscription allocation", api: "API equivalent" };
type Sort = keyof typeof columns;
type TicketRow = Costs["tickets"][number];
const sortValue = (ticket: TicketRow, column: Sort) => {
	switch (column) {
		case "ticket":
			return ticket.id;
		case "tokens":
			return ticket.turns ? tokens(ticket) : undefined;
		case "subscription":
			return ticket.subscriptionAud;
		case "api":
			return ticket.apiAud;
	}
};

const TicketCosts = ({ cost }: { cost: Costs }) => {
	const [sort, setSort] = useState<{ column: Sort; ascending: boolean }>({ column: "tokens", ascending: false });
	const tickets = [...cost.tickets].sort((a, b) => {
		const left = sortValue(a, sort.column);
		const right = sortValue(b, sort.column);
		if (left === undefined || right === undefined) return Number(left === undefined) - Number(right === undefined);
		const order =
			typeof left === "string"
				? left.localeCompare(String(right), "en-AU", { numeric: true })
				: left - Number(right);
		return sort.ascending ? order : -order;
	});
	const scale = tickets.reduce((max, ticket) => Math.max(max, tokens(ticket)), 1);
	return (
		<section className='cost-card'>
			<h3>Usage and cost by ticket</h3>
			{!tickets.length ? (
				<p className='cost-muted'>No tickets yet.</p>
			) : (
				<div className='cost-table-scroll' role='region' aria-label='Ticket costs' tabIndex={0}>
					<table className='cost-table'>
						<thead>
							<tr>
								{(Object.keys(columns) as Sort[]).map((column) => (
									<th
										key={column}
										scope='col'
										aria-sort={
											sort.column === column
												? sort.ascending
													? "ascending"
													: "descending"
												: undefined
										}
									>
										<button
											onClick={() =>
												setSort({
													column,
													ascending:
														sort.column === column ? !sort.ascending : column === "ticket",
												})
											}
										>
											{columns[column]}
											{sort.column === column && (
												<span aria-hidden='true'>{sort.ascending ? " ↑" : " ↓"}</span>
											)}
										</button>
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{tickets.map((ticket) => (
								<tr key={ticket.id}>
									<th scope='row'>
										<Link
											to={`/projects/${ticket.projectId}/tasks?ticket=${encodeURIComponent(ticket.id)}`}
										>
											<span className='cost-muted'>{ticket.id}</span> {ticket.title}
										</Link>
										<small>{ticket.projectName}</small>
										{ticket.archivedAt && <small>Archived</small>}
									</th>
									<td>
										{ticket.turns ? (
											<>
												<span>{number.format(tokens(ticket))}</span>
												<span className='cost-bar' aria-hidden='true'>
													<span style={{ width: `${(100 * tokens(ticket)) / scale}%` }} />
												</span>
											</>
										) : (
											"—"
										)}
									</td>
									<td>
										{formatAud(ticket.subscriptionAud)}
										{ticket.untimedTurns > 0 && (
											<small>
												{ticket.untimedTurns} {ticket.untimedTurns === 1 ? "turn" : "turns"}{" "}
												missing duration
											</small>
										)}
									</td>
									<td>
										{formatAud(ticket.apiAud)}
										{ticket.unpricedTurns > 0 && (
											<small>
												{ticket.unpricedTurns} {ticket.unpricedTurns === 1 ? "turn" : "turns"}{" "}
												missing pricing
											</small>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			<p className='cost-muted cost-method'>
				Subscription allocation uses recorded turn duration and the monthly rate at dispatch. The current
				setting is {formatAud(cost.monthlyAud)}/month. API estimates use standard text token prices and{" "}
				{formatAud(cost.audPerUsd)} per US$1 as of {cost.exchangeDate}.
			</p>
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
					<dl className='cost-metrics'>
						<div className='cost-card'>
							<dt>Ticket subscription allocation estimate</dt>
							<dd>{formatAud(cost.ticketEstimates.subscriptionAud)}</dd>
							{cost.ticketEstimates.untimedTurns > 0 && (
								<small>Incomplete: {cost.ticketEstimates.untimedTurns} turns missing duration</small>
							)}
						</div>
						<div className='cost-card'>
							<dt>Ticket API equivalent estimate</dt>
							<dd>{formatAud(cost.ticketEstimates.apiAud)}</dd>
							{cost.ticketEstimates.unpricedTurns > 0 && (
								<small>Incomplete: {cost.ticketEstimates.unpricedTurns} turns missing pricing</small>
							)}
						</div>
						<div className='cost-card'>
							<dt>Total tokens</dt>
							<dd>{number.format(tokens(cost.totals))}</dd>
						</div>
						<div className='cost-card'>
							<dt>Input tokens</dt>
							<dd>{number.format(cost.totals.input)}</dd>
						</div>
						<div className='cost-card'>
							<dt>Cached input</dt>
							<dd>{number.format(cost.totals.cached)}</dd>
						</div>
						<div className='cost-card'>
							<dt>Output tokens</dt>
							<dd>{number.format(cost.totals.output)}</dd>
						</div>
					</dl>
					<WeeklyBudgetChart budget={cost.weeklyBudget} />
					<UsageCharts cost={cost} />
					<Quotas limits={cost.limits} />
					<TicketCosts cost={cost} />
				</>
			)}
		</div>
	);
};
