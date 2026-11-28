import type { AgentItem } from "@forge/contracts/agents";
import { lazy, Suspense, useState, type ReactNode } from "react";

const Markdown = lazy(() => import("react-markdown"));

export const PlanMarkdown = ({ text }: { text: string }) => (
	<Suspense fallback={<div>{text}</div>}>
		<Markdown skipHtml disallowedElements={["img"]}>
			{text}
		</Markdown>
	</Suspense>
);

export function parseJsonObject(text: string): { value: Record<string, unknown>; payload: string } | undefined {
	const fence = /^\s*```json[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(text);
	const payload = fence ? fence[1]! : text;
	try {
		const value: unknown = JSON.parse(payload);
		if (value !== null && typeof value === "object" && !Array.isArray(value))
			return { value: value as Record<string, unknown>, payload };
	} catch {
		/* Render invalid candidates as Markdown. */
	}
	return undefined;
}

const JsonRow = ({ name, value }: { name: string; value: unknown }) => {
	const [open, setOpen] = useState(false);
	const container = value !== null && typeof value === "object";
	const entries = container ? Object.entries(value) : [];
	return (
		<div className='agent-json-row'>
			{container ? (
				<button type='button' aria-expanded={open} onClick={() => setOpen(!open)}>
					{open ? "▾" : "▸"} {name}: {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
				</button>
			) : (
				<div>
					<span className='agent-json-key'>{name}</span>:{" "}
					<span className={`agent-json-${value === null ? "null" : typeof value}`}>
						{JSON.stringify(value)}
					</span>
				</div>
			)}
			{container && open && (
				<div className='agent-json-children'>
					{entries.map(([key, child]) => (
						<JsonRow key={key} name={key} value={child} />
					))}
				</div>
			)}
		</div>
	);
};

const JsonTree = ({ value, payload }: { value: Record<string, unknown>; payload: string }) => {
	const [status, setStatus] = useState("");
	return (
		<div className='agent-json'>
			<div className='agent-json-header'>
				<button
					type='button'
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(payload);
							setStatus("Copied JSON");
						} catch {
							setStatus("Could not copy JSON");
						}
					}}
				>
					Copy JSON
				</button>
			</div>
			<div role='status'>{status}</div>
			{Object.entries(value).map(([key, child]) => (
				<JsonRow key={key} name={key} value={child} />
			))}
			{Object.keys(value).length === 0 && <span>{"{}"}</span>}
		</div>
	);
};

const ToolGroup = ({ items }: { items: AgentItem[] }) => {
	const running = items.some((item) => item.status === "running");
	const failed = items.some((item) => item.status === "failed");
	const status = running
		? "running"
		: failed
			? "failed"
			: items.every((item) => item.status === "completed")
				? "completed"
				: undefined;
	return (
		<details className='agent-tool-group'>
			<summary>
				<span className='agent-tool-indicator' data-status={status} aria-hidden='true'>
					{running ? "◌" : failed ? "!" : status === "completed" ? "✓" : "·"}
				</span>
				<span className={running ? "agent-working-highlight" : undefined}>
					{running ? "Working" : failed ? "Tool calls failed" : "Explored"} · {items.length} tool{" "}
					{items.length === 1 ? "call" : "calls"}
				</span>
				<span className='agent-tool-chevron' aria-hidden='true'>
					›
				</span>
			</summary>
			<div className='agent-tool-list'>
				{items.map((item) => (
					<details key={item.id} className='agent-activity' data-status={item.status}>
						<summary>
							<span className={item.status === "running" ? "agent-working-highlight" : undefined}>
								{item.title ?? item.text.split("\n").at(0) ?? "Tool activity"}
							</span>
							<small>
								{item.status === "running"
									? "Running"
									: item.status === "failed"
										? "Failed"
										: item.status === "interrupted"
											? "Interrupted"
											: item.status === "completed"
												? "Completed"
												: "Tool activity"}
							</small>
						</summary>
						<pre>{item.text}</pre>
					</details>
				))}
			</div>
		</details>
	);
};

export const AgentActivity = ({
	items,
	planAction,
	planText,
	planMarkdown,
}: {
	items: AgentItem[];
	planAction?: ReactNode;
	planText?: string;
	planMarkdown?: string;
}) => {
	const latestPlan = items.findLast((item) => item.kind === "plan" && item.text.trim() === planText?.trim());
	const groups: AgentItem[][] = [];
	for (const item of items) {
		const last = groups.at(-1);
		if (item.role === "activity" && last?.at(0)?.role === "activity") last.push(item);
		else groups.push([item]);
	}
	return groups.map((group) => {
		const item = group.at(0)!;
		const json =
			item.role === "assistant" && item.kind !== "plan" && item.finalAnswer
				? parseJsonObject(item.text)
				: undefined;
		return item.role === "activity" ? (
			<ToolGroup key={item.id} items={group} />
		) : (
			<article
				key={item.id}
				className={`agent-message agent-message-${item.role}`}
				aria-label={item.role === "user" ? "You" : "Codex"}
			>
				{item.kind === "plan" ? (
					<PlanMarkdown text={item === latestPlan ? (planMarkdown ?? item.text) : item.text} />
				) : item.role === "user" ? (
					<div>{item.text}</div>
				) : json ? (
					<JsonTree value={json.value} payload={json.payload} />
				) : (
					<div className='agent-markdown'>
						<PlanMarkdown text={item.text} />
					</div>
				)}
				{item === latestPlan && planAction}
			</article>
		);
	});
};
