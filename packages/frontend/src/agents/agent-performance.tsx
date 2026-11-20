import type { AgentView } from "@forge/contracts/agents";
import { useId, useState } from "react";

const seconds = (ms: number | undefined) => (ms === undefined ? "Unavailable" : `${(ms / 1000).toFixed(2)} s`);
const rate = (tokens: number, ms: number | undefined) =>
	ms && ms > 0 ? `${((tokens * 1000) / ms).toFixed(1)} tokens/s` : "Unavailable";

export const AgentPerformanceStat = ({ view }: { view: AgentView }) => {
	const id = useId();
	const [open, setOpen] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const p = view.performance?.turnId === view.thread.turnId ? view.performance : undefined;
	const measured = p && p.state !== "unavailable" && p.requestDurationMs > 0 && p.outputTokens > 0;
	const label = measured
		? `${rate(p.outputTokens, p.requestDurationMs)}${p.state === "partial" ? " · Partial" : ""}`
		: ["running", "waiting"].includes(view.thread.status) && !p?.requestCount
			? "Measuring…"
			: "Unavailable";
	return (
		<div
			className={`agent-performance${open ? " agent-performance-open" : ""}${dismissed ? " agent-performance-dismissed" : ""}`}
			onMouseEnter={() => setDismissed(false)}
		>
			<button
				type='button'
				aria-label={`Inference speed: ${label}`}
				aria-describedby={id}
				onFocus={() => setDismissed(false)}
				onClick={() => {
					setDismissed(open);
					setOpen(!open);
				}}
				onBlur={() => {
					setOpen(false);
					setDismissed(false);
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						setOpen(false);
						setDismissed(true);
					}
				}}
			>
				{label}
			</button>
			<div id={id} role='tooltip' className='agent-performance-tooltip'>
				<strong>Client-observed model requests, including transport latency</strong>
				<div>Output tokens: {p?.outputTokens ?? "Unavailable"}</div>
				<div>Model-request time: {seconds(measured ? p.requestDurationMs : undefined)}</div>
				<div>Time to first token: {seconds(p?.firstTokenLatencyMs)}</div>
				<div>Generation speed: {rate(p?.outputTokens ?? 0, p?.generationDurationMs)}</div>
				<div>Effective rate: {measured ? rate(p.outputTokens, p.requestDurationMs) : "Unavailable"}</div>
				{p?.state === "partial" && <div>Partial: some request timing or token counts are missing.</div>}
			</div>
		</div>
	);
};
