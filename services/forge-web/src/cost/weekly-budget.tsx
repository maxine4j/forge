import type { WeeklyBudget } from "@forge/contracts";
import { useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

import { Dropdown, DropdownOption } from "../dropdown.tsx";

const timestamp = (value: string | number) => new Date(value).toLocaleString();
const labelDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const formatPercent = (value: number) => `${percent.format(value)}%`;

const observations = (bucket: WeeklyBudget["buckets"][number]) => {
	const points: { time: number; remaining: number | null }[] = [];
	for (const point of bucket.observations) {
		if (point.resetsAt !== bucket.resetsAt) continue;
		const time = Date.parse(point.observedAt);
		const previous = points.at(-1);
		if (previous && time - previous.time > 900_000)
			points.push({ time: (previous.time + time) / 2, remaining: null });
		points.push({ time, remaining: 100 - point.usedPercent });
	}
	return points;
};

export function WeeklyBudgetChart({ budget }: { budget?: WeeklyBudget }) {
	const [selected, setSelected] = useState<string>();
	const bucket =
		budget?.buckets.find((entry) => entry.bucketId === (selected ?? budget.defaultBucketId)) ?? budget?.buckets[0];
	const reset = bucket ? Date.parse(bucket.resetsAt) : 0;
	const start = reset - 7 * 86_400_000;
	return (
		<section className='cost-card'>
			<h3>Weekly budget burndown</h3>
			{(budget?.buckets.length ?? 0) > 1 && (
				<label>
					Weekly bucket{" "}
					<Dropdown
						aria-label='Weekly bucket'
						value={bucket?.bucketId ?? ""}
						onChange={(value) => setSelected(value)}
					>
						{budget?.buckets.map((entry) => (
							<DropdownOption key={entry.bucketId} value={entry.bucketId}>
								{entry.bucket} ({entry.bucketId})
							</DropdownOption>
						))}
					</Dropdown>
				</label>
			)}
			{!bucket ? (
				<p>Learning usage pattern. No weekly quota observations yet.</p>
			) : (
				<>
					<p>
						{bucket.bucket} · {bucket.remainingPercent}% remaining at last observation
					</p>
					<p>
						Resets {timestamp(bucket.resetsAt)} · Last observation {timestamp(bucket.lastObservedAt)}
					</p>
					<LineChart
						className='cost-chart cost-budget-chart'
						responsive
						data={observations(bucket)}
						aria-label={`${bucket.bucket} weekly remaining allowance from 100% to 0%`}
						desc='Recorded observations in the current reset cycle. Gaps exceed fifteen minutes. The dashed line shows a straight-line budget reference.'
						margin={{ top: 10, right: 22, bottom: 0, left: 0 }}
					>
						<CartesianGrid vertical={false} stroke='var(--cost-border)' />
						<XAxis
							dataKey='time'
							type='number'
							domain={[start, reset]}
							ticks={[start, start + 3 * 86_400_000, reset]}
							tickFormatter={labelDate.format}
							allowDataOverflow
						/>
						<YAxis
							domain={[0, 100]}
							ticks={[0, 25, 50, 75, 100]}
							width={42}
							tickFormatter={formatPercent}
						/>
						<ReferenceLine
							segment={[
								{ x: start, y: 100 },
								{ x: reset, y: 0 },
							]}
							stroke='var(--cost-muted)'
							strokeDasharray='5 5'
						/>
						<Tooltip
							labelFormatter={(value) => timestamp(Number(value))}
							formatter={(value) => (typeof value === "number" ? formatPercent(value) : value)}
							contentStyle={{ background: "var(--cost-tooltip)", borderColor: "var(--cost-border)" }}
						/>
						<Line
							dataKey='remaining'
							name='Remaining allowance'
							stroke='var(--cost-accent)'
							strokeWidth={2}
							dot={{ r: 1.5, strokeWidth: 0, fill: "var(--cost-accent)" }}
							isAnimationActive={false}
						/>
					</LineChart>
					<p>
						<strong>Estimated additional tickets: </strong>
						{bucket.additionalTickets !== undefined
							? `≈ ${bucket.additionalTickets}`
							: bucket.unavailable === "learning"
								? "Learning usage pattern"
								: bucket.unavailable === "stale"
									? "Unavailable: latest observation is over fifteen minutes old"
									: "Unavailable: reset has passed"}
					</p>
					<p>
						{bucket.completedTickets} completed tickets · {bucket.coverageHours.toFixed(1)} observed hours
						{bucket.periodStart
							&& bucket.periodEnd
							&& ` · ${timestamp(bucket.periodStart)} to ${timestamp(bucket.periodEnd)}`}
					</p>
				</>
			)}
		</section>
	);
}
