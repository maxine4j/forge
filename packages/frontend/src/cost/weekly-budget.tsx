import type { WeeklyBudget } from "@forge/contracts";
import { useState } from "react";

import { Dropdown, DropdownOption } from "../dropdown.tsx";

const timestamp = (value: string) => new Date(value).toLocaleString();
export function WeeklyBudgetChart({ budget }: { budget?: WeeklyBudget }) {
	const [selected, setSelected] = useState<string>();
	const bucket =
		budget?.buckets.find((entry) => entry.bucketId === (selected ?? budget.defaultBucketId)) ?? budget?.buckets[0];
	const latest = bucket?.observations.at(-1);
	const reset = latest ? Date.parse(latest.resetsAt) : 0;
	const start = reset - 7 * 86_400_000;
	const x = (value: string) => 45 + (620 * (Date.parse(value) - start)) / (reset - start);
	const points = bucket?.observations.filter((entry) => entry.resetsAt === latest?.resetsAt);
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
						{bucket.bucket} · {bucket.remainingPercent}% remaining
					</p>
					<p>
						Resets {timestamp(bucket.resetsAt)} · Last observation {timestamp(bucket.lastObservedAt)}
					</p>
					<svg
						viewBox='0 0 700 240'
						role='img'
						aria-label={`${bucket.bucket} weekly remaining allowance from 100% to 0%`}
						aria-description='Recorded observations in the current reset cycle. Gaps exceed fifteen minutes. The dashed line shows a straight-line budget reference.'
						style={{ width: "100%", height: "auto" }}
					>
						<text x='0' y='25' fill='currentColor'>
							100%
						</text>
						<text x='10' y='205' fill='currentColor'>
							0%
						</text>
						<path
							d='M45 20 L665 200'
							stroke='currentColor'
							strokeDasharray='6 5'
							fill='none'
							opacity='.4'
						/>
						{points?.map((point, index) => {
							const previous = points[index - 1];
							const y = 20 + point.usedPercent * 1.8;
							return (
								<g key={point.observedAt}>
									{previous
										&& Date.parse(point.observedAt) - Date.parse(previous.observedAt)
											<= 900_000 && (
											<line
												x1={x(previous.observedAt)}
												y1={20 + previous.usedPercent * 1.8}
												x2={x(point.observedAt)}
												y2={y}
												stroke='currentColor'
												strokeWidth='2'
											/>
										)}
									<circle cx={x(point.observedAt)} cy={y} r='3' fill='currentColor'>
										<title>
											{timestamp(point.observedAt)}: {100 - point.usedPercent}% remaining
										</title>
									</circle>
								</g>
							);
						})}
						<text x='45' y='230' fill='currentColor'>
							{new Date(start).toLocaleDateString()}
						</text>
						<text x='665' y='230' textAnchor='end' fill='currentColor'>
							{new Date(reset).toLocaleDateString()}
						</text>
					</svg>
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
					<details>
						<summary>Recorded timestamp and remaining allowance</summary>
						{[...new Set(bucket.observations.map((point) => point.resetsAt))].map((cycle) => (
							<div key={cycle}>
								<h4>Reset {timestamp(cycle)}</h4>
								<ul>
									{bucket.observations
										.filter((point) => point.resetsAt === cycle)
										.map((point) => (
											<li key={point.observedAt}>
												{timestamp(point.observedAt)} · {100 - point.usedPercent}% remaining
											</li>
										))}
								</ul>
							</div>
						))}
					</details>
				</>
			)}
			<p className='cost-muted'>
				Account-wide budget capacity, not a guarantee of completion before reset. Standalone chats, other
				account activity and changing ticket complexity affect this estimate.
			</p>
		</section>
	);
}
