import type { WeeklyBudget } from "@forge/contracts";
import { useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from "recharts";

import { Dropdown, DropdownOption } from "../dropdown.tsx";

const timestamp = (value: string | number) => new Date(value).toLocaleString();
const labelDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const formatPercent = (value: number) => `${percent.format(value)}%`;

export const chartData = (bucket: WeeklyBudget["buckets"][number], window: WeeklyBudget["window"]) => {
	const from = Date.parse(window.from),
		to = Date.parse(window.to),
		week = 7 * 86_400_000;
	const cycles = new Map<string, typeof bucket.observations>();
	for (const observation of bucket.observations) {
		const group = cycles.get(observation.resetsAt) ?? [];
		group.push(observation);
		cycles.set(observation.resetsAt, group);
	}
	const points: { time: number; remaining: number | null; reset?: number }[] = [];
	const references: { start: number; end: number; first: number; last: number }[] = [];
	for (const [reset, group] of [...cycles].sort(([a], [b]) => a.localeCompare(b))) {
		const end = Date.parse(reset),
			start = end - week;
		const left = Math.max(start, from),
			right = Math.min(end, to);
		if (left <= right)
			references.push({
				start: left,
				end: right,
				first: (100 * (end - left)) / week,
				last: (100 * (end - right)) / week,
			});
		group.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
		if (points.length) points.push({ time: (points.at(-1)!.time + start) / 2, remaining: null });
		let previous: number | undefined;
		let previousIsReset = false;
		if (start >= from && start <= to) {
			points.push({ time: start, remaining: 100, reset: 100 });
			previous = start;
			previousIsReset = true;
		}
		for (const point of group) {
			const time = Date.parse(point.observedAt);
			if (time < from || time > to) continue;
			if (previous !== undefined && (time - previous > 900_000 || (previousIsReset && time <= previous)))
				points.push({ time: (previous + time) / 2, remaining: null });
			points.push({ time, remaining: 100 - point.usedPercent });
			previous = time;
			previousIsReset = false;
		}
	}
	return { points, references };
};

export function WeeklyBudgetChart({ budget }: { budget?: WeeklyBudget }) {
	const [selected, setSelected] = useState<string>();
	const bucket =
		budget?.buckets.find((entry) => entry.bucketId === (selected ?? budget.defaultBucketId)) ?? budget?.buckets[0];
	const start = budget ? Date.parse(budget.window.from) : 0;
	const end = budget ? Date.parse(budget.window.to) : 0;
	const data = bucket && budget ? chartData(bucket, budget.window) : undefined;
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
						data={data?.points}
						aria-label={`${bucket.bucket} weekly remaining allowance from 100% to 0%`}
						desc='Recorded observations across weekly reset cycles. Gaps exceed fifteen minutes. Dashed lines show straight-line budget references.'
						margin={{ top: 10, right: 22, bottom: 0, left: 0 }}
					>
						<CartesianGrid vertical={false} stroke='var(--cost-border)' />
						<XAxis
							dataKey='time'
							type='number'
							domain={[start, end]}
							ticks={[start, (start + end) / 2, end]}
							tickFormatter={
								end - start <= 86_400_000
									? (value) =>
											new Date(value).toLocaleTimeString([], {
												hour: "2-digit",
												minute: "2-digit",
											})
									: labelDate.format
							}
							allowDataOverflow
						/>
						<YAxis
							domain={[0, 100]}
							ticks={[0, 25, 50, 75, 100]}
							width={42}
							tickFormatter={formatPercent}
						/>
						{data?.references.map((reference) => (
							<ReferenceLine
								key={reference.start}
								segment={[
									{ x: reference.start, y: reference.first },
									{ x: reference.end, y: reference.last },
								]}
								stroke='var(--cost-muted)'
								strokeDasharray='5 5'
							/>
						))}
						<Tooltip
							labelFormatter={(value) => timestamp(Number(value))}
							formatter={(value, _name, entry) => [
								typeof value === "number" ? formatPercent(value) : value,
								entry.payload?.reset ? "Weekly reset" : "Remaining allowance",
							]}
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
