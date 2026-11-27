import { costRangeSchema, costsSchema, defaultCostRange, type Costs } from "@forge/contracts";
import { useEffect, useState } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { Dropdown, DropdownOption } from "../dropdown.tsx";
import { nextModal } from "../navigation/controller.tsx";
import { useToast } from "../toasts/toasts.tsx";
import { Money, PhaseCosts, WeeklyUsage, formatPercent } from "./cost-metrics.tsx";
import { WeeklyBudgetChart } from "./weekly-budget.tsx";

const number = new Intl.NumberFormat("en-AU");
const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
const workShare = new Intl.NumberFormat("en-AU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const providerLabels = { openai: "OpenAI", ollama: "Ollama" } as const;
const shortNumber = new Intl.NumberFormat("en-AU", { notation: "compact" });
const day = new Intl.DateTimeFormat("en-AU", { month: "short", day: "numeric", timeZone: "UTC" });
const hour = new Intl.DateTimeFormat("en-AU", {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
	hourCycle: "h23",
	timeZone: "UTC",
});
const presets = ["-28d", "-7d", "-1d", "-12hr", "-1hr"];
const resetTime = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short" });
const tokens = (value: { input: number; output: number }) => value.input + value.output;
const phaseLabels = {
	planning: "Planning",
	implementation: "Implementation",
	review: "Review",
	rebase: "Rebase",
};

const UsageCharts = ({ cost }: { cost: Costs }) => {
	const series = cost.hours ?? cost.days;
	const format = (date: string) => (cost.hours ? hour : day).format(new Date(date));
	const ticketPhases = cost.phases.filter(
		(entry): entry is Costs["phases"][number] & { phase: keyof typeof phaseLabels } => entry.phase !== "chat",
	);
	const phaseScale = Math.max(1, ...ticketPhases.map(tokens));
	return (
		<div className='cost-charts'>
			<section className='cost-card'>
				<h3>Token usage over time</h3>
				{series.every((entry) => tokens(entry) === 0) ? (
					<p className='cost-muted'>No tokens recorded in this period.</p>
				) : (
					<>
						<BarChart
							className='cost-chart cost-token-chart'
							responsive
							data={series.map((entry) => ({ ...entry, uncached: entry.input - entry.cached }))}
							aria-label={cost.hours ? "Hourly token usage" : "Daily token usage"}
							margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
						>
							<CartesianGrid vertical={false} stroke='var(--cost-border)' />
							<XAxis dataKey='date' tickFormatter={format} minTickGap={20} interval='preserveStartEnd' />
							<YAxis width={36} tickCount={4} allowDecimals={false} tickFormatter={shortNumber.format} />
							<Tooltip
								labelFormatter={(value) => format(String(value))}
								formatter={(value) => (typeof value === "number" ? number.format(value) : value)}
								contentStyle={{ background: "var(--cost-tooltip)", borderColor: "var(--cost-border)" }}
								cursor={{ fill: "var(--cost-muted)", fillOpacity: 0.12 }}
							/>
							<Bar
								dataKey='uncached'
								name='Input'
								stackId='tokens'
								fill='var(--cost-input)'
								isAnimationActive={false}
							/>
							<Bar
								dataKey='cached'
								name='Cached input'
								stackId='tokens'
								fill='var(--cost-cached)'
								isAnimationActive={false}
							/>
							<Bar
								dataKey='output'
								name='Output'
								stackId='tokens'
								fill='var(--cost-output)'
								isAnimationActive={false}
							/>
						</BarChart>
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
							<summary>{cost.hours ? "Hourly" : "Daily"} values (UTC)</summary>
							<ul>
								{series.map((entry) => (
									<li key={entry.date}>
										<time dateTime={entry.date}>{format(entry.date)}</time>{" "}
										<span>{number.format(tokens(entry))} tokens</span>
									</li>
								))}
							</ul>
						</details>
					</>
				)}
			</section>
			<section className='cost-card'>
				<h3>Ticket tokens by phase</h3>
				{!ticketPhases.length ? (
					<p className='cost-muted'>No phase usage recorded yet.</p>
				) : (
					<div
						className='cost-phases'
						role='img'
						aria-label='Ticket tokens by phase'
						aria-description={ticketPhases
							.map((entry) => `${phaseLabels[entry.phase]} ${number.format(tokens(entry))}`)
							.join(", ")}
					>
						{ticketPhases.map((entry) => (
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
			<h3>Current Codex account limits</h3>
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

const ProviderEstimate = ({
	value,
	incomplete,
	currency = false,
}: {
	value?: number;
	incomplete: number;
	currency?: boolean;
}) => (
	<>
		<span>
			{value === undefined ? "Unavailable" : currency ? `AUD ${aud.format(value)}` : formatPercent(value)}
		</span>
		{incomplete > 0 && (
			<small>
				{incomplete} {incomplete === 1 ? "turn" : "turns"} without an estimate
			</small>
		)}
	</>
);

const ProviderCosts = ({ cost }: { cost: Costs }) => {
	const weekly = cost.limits?.windows.filter((window) => window.minutes === 10080) ?? [];
	const current = weekly.length === 1 ? weekly.at(0) : weekly.find((window) => window.bucketId === "codex");
	const remaining = current && Math.max(0, 100 - current.usedPercent);
	return (
		<>
			<div className='cost-provider-summary'>
				{(Object.keys(providerLabels) as (keyof typeof providerLabels)[]).map((kind) => {
					const usage = cost.providerTotals[kind];
					return (
						<section
							key={kind}
							className='cost-card cost-provider'
							aria-labelledby={`cost-provider-${kind}`}
						>
							<h3 id={`cost-provider-${kind}`}>{providerLabels[kind]}</h3>
							<dl className='cost-metrics'>
								<div>
									<dt>Input tokens</dt>
									<dd>{number.format(usage.input)}</dd>
								</div>
								<div>
									<dt>Cached input</dt>
									<dd>{number.format(usage.cached)}</dd>
								</div>
								<div>
									<dt>Output tokens</dt>
									<dd>{number.format(usage.output)}</dd>
								</div>
								<div>
									<dt>
										{kind === "ollama" ? "OpenAI API equivalent (estimate)" : "Estimated API cost"}
									</dt>
									<dd>
										<ProviderEstimate value={usage.apiAud} incomplete={usage.incomplete} currency />
									</dd>
								</div>
								{kind === "ollama" ? (
									<div>
										<dt>Weekly limit saved (estimate)</dt>
										<dd>
											<ProviderEstimate
												value={cost.providerTotals.ollama.weeklySavedPercent}
												incomplete={cost.providerTotals.ollama.incompleteWeekly}
											/>
										</dd>
									</div>
								) : (
									<div>
										<dt>Weekly limit remaining</dt>
										<dd>
											{remaining === undefined ? "Unavailable" : `${number.format(remaining)}%`}
											{current?.resetsAt && (
												<small>Resets {resetTime.format(new Date(current.resetsAt))}</small>
											)}
										</dd>
									</div>
								)}
							</dl>
							{usage.incompleteTokens > 0 && (
								<small>
									Token counts missing for {usage.incompleteTokens}{" "}
									{usage.incompleteTokens === 1 ? "turn" : "turns"}.
								</small>
							)}
						</section>
					);
				})}
			</div>
			<section className='cost-card'>
				<h3>Usage and cost by provider</h3>
				{cost.providers.length ? (
					<>
						<p className='cost-muted'>
							Work share uses recorded input and output tokens. Input includes cached tokens. Ollama
							estimates use the OpenAI default model at dispatch and observed weekly quota usage in this
							range.
						</p>
						<div className='cost-table-scroll' role='region' aria-label='Provider costs' tabIndex={0}>
							<table className='cost-table'>
								<thead>
									<tr>
										<th>Provider</th>
										<th>Input</th>
										<th>Cached input</th>
										<th>Output</th>
										<th>Work share</th>
										<th>Estimated API cost</th>
										<th>Weekly limit saved (estimate)</th>
									</tr>
								</thead>
								{(Object.keys(providerLabels) as (keyof typeof providerLabels)[]).map((kind) => {
									const providers = cost.providers.filter((provider) => provider.kind === kind);
									if (!providers.length) return null;
									return (
										<tbody key={kind}>
											<tr>
												<th scope='rowgroup' colSpan={7}>
													{providerLabels[kind]}
												</th>
											</tr>
											{providers.map((provider) => (
												<tr key={provider.id}>
													<th scope='row'>
														{provider.name}
														{provider.incompleteTokens > 0 && (
															<small>Incomplete token counts</small>
														)}
													</th>
													<td>{number.format(provider.input)}</td>
													<td>{number.format(provider.cached)}</td>
													<td>{number.format(provider.output)}</td>
													<td>{workShare.format(provider.workSharePercent)}%</td>
													<td>
														<ProviderEstimate
															value={provider.apiAud}
															incomplete={provider.incomplete}
															currency
														/>
													</td>
													<td>
														{provider.kind === "ollama" ? (
															<ProviderEstimate
																value={provider.weeklySavedPercent}
																incomplete={provider.incompleteWeekly}
															/>
														) : (
															"—"
														)}
													</td>
												</tr>
											))}
										</tbody>
									);
								})}
							</table>
						</div>
					</>
				) : (
					<p className='cost-muted'>No providers with recorded usage or active configuration.</p>
				)}
			</section>
			<WeeklyBudgetChart budget={cost.weeklyBudget} />
			<Quotas limits={cost.limits} />
		</>
	);
};

const TicketCosts = ({ cost }: { cost: Costs }) => {
	const location = useLocation();
	const ticketUrl = (id: string) => {
		const query = new URLSearchParams(location.search);
		query.set("ticket", id);
		query.delete("tab");
		return `${location.pathname}?${query}${location.hash}`;
	};
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
				<Dropdown aria-label='Sort tickets' value={sort} onChange={(value) => setSort(value)}>
					<DropdownOption value='ticket'>Ticket</DropdownOption>
					<DropdownOption value='tokens'>Tokens</DropdownOption>
					<DropdownOption value='api'>Estimated API cost</DropdownOption>
					<DropdownOption value='weekly'>Weekly limit spent</DropdownOption>
					<DropdownOption value='effective'>Effective cost</DropdownOption>
				</Dropdown>
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
								<th>Estimated OpenAI API cost</th>
								<th>Weekly limit spent (estimate)</th>
								<th>Effective cost (estimate)</th>
							</tr>
						</thead>
						<tbody>
							{tickets.map((ticket) => (
								<tr key={ticket.id}>
									<th>
										<Link to={ticketUrl(ticket.id)} state={nextModal(location, "ticket")}>
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

export default function CostDashboard({ api }: { api: IWorkspaceApi }) {
	const { notify } = useToast();
	const [query, setQuery] = useSearchParams();
	const range = costRangeSchema.safeParse(query.get("range")).data ?? defaultCostRange;
	const [custom, setCustom] = useState<string>();
	const [rangeError, setRangeError] = useState(false);
	const selectRange = (value: string) => {
		setRangeError(false);
		if (value === "custom") {
			setCustom(presets.includes(range) ? "" : range);
			return;
		}
		setCustom(undefined);
		setQuery((previous) => {
			const next = new URLSearchParams(previous);
			if (value === defaultCostRange) next.delete("range");
			else next.set("range", value);
			return next;
		});
	};
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		const timer = window.setInterval(() => setAttempt((value) => value + 1), 300_000);
		return () => window.clearInterval(timer);
	}, []);
	const [result, setResult] = useState<{ attempt: number; range: string; value?: Costs }>();
	useEffect(() => {
		let current = true;
		void api.read(`costs?range=${range}`, costsSchema).then(
			(value) => {
				if (current) setResult({ attempt, range, value });
			},
			() => {
				if (current) {
					setResult({ attempt, range });
					notify("Cost data is unavailable.");
				}
			},
		);
		return () => {
			current = false;
		};
	}, [api, attempt, notify, range]);
	const cost = result?.range === range ? result.value : undefined;
	const pending = result?.range !== range || result.attempt !== attempt;
	return (
		<div className='cost-dashboard' aria-busy={pending}>
			<header className='cost-heading cost-title'>
				<div>
					<h2>Costs</h2>
					{cost && <p className='cost-muted'>Recorded since {cost.since.slice(0, 10)} (UTC)</p>}
				</div>
				<div className='cost-controls'>
					<Dropdown aria-label='Cost time range' value={range} onChange={selectRange}>
						{presets.map((preset) => (
							<DropdownOption key={preset} value={preset}>
								{preset}
							</DropdownOption>
						))}
						{!presets.includes(range) && <DropdownOption value={range}>{range}</DropdownOption>}
						<DropdownOption value='custom'>Custom range…</DropdownOption>
					</Dropdown>
					<button disabled={pending || !cost} onClick={() => setAttempt((value) => value + 1)}>
						Refresh
					</button>
				</div>
			</header>
			{custom !== undefined && (
				<form
					className='cost-controls'
					onSubmit={(event) => {
						event.preventDefault();
						const parsed = costRangeSchema.safeParse(custom.trim());
						if (parsed.success) selectRange(parsed.data);
						else setRangeError(true);
					}}
				>
					<label>
						Custom range{" "}
						<input
							placeholder='-14d'
							value={custom}
							onChange={(event) => {
								setCustom(event.target.value);
								setRangeError(false);
							}}
							aria-invalid={rangeError}
						/>
					</label>
					<button type='submit'>Apply</button>
					<button type='button' onClick={() => setCustom(undefined)}>
						Cancel
					</button>
					{rangeError && <span role='alert'>Enter a range such as -14d or -12hr.</span>}
				</form>
			)}
			{pending && !cost && <p role='status'>Loading cost data…</p>}
			{!pending && !cost && (
				<div className='cost-card'>
					<button onClick={() => setAttempt((value) => value + 1)}>Retry</button>
				</div>
			)}
			{cost && (
				<>
					<ProviderCosts cost={cost} />
					<UsageCharts cost={cost} />
					<TicketCosts cost={cost} />
				</>
			)}
		</div>
	);
}
