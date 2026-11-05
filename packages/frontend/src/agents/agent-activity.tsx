import type { AgentItem } from "@forge/contracts/agents";

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

export const AgentActivity = ({ items }: { items: AgentItem[] }) => {
	const groups: AgentItem[][] = [];
	for (const item of items) {
		const last = groups.at(-1);
		if (item.role === "activity" && last?.at(0)?.role === "activity") last.push(item);
		else groups.push([item]);
	}
	return groups.map((group) => {
		const item = group.at(0)!;
		return item.role === "activity" ? (
			<ToolGroup key={item.id} items={group} />
		) : (
			<article
				key={item.id}
				className={`agent-message agent-message-${item.role}`}
				aria-label={item.role === "user" ? "You" : "Codex"}
			>
				<div>{item.text}</div>
			</article>
		);
	});
};
