import { useState, type ReactNode } from "react";

import { PlanMarkdown } from "../agents/agent-activity.tsx";

export const TicketTextPreview = ({
	text,
	children,
}: {
	text: string;
	children?: (content: ReactNode) => ReactNode;
}) => {
	const [expandedSource, setExpandedSource] = useState<string>();
	const lines = text.split("\n");
	const expanded = expandedSource === text;
	const content = <PlanMarkdown text={expanded ? text : lines.slice(0, 10).join("\n")} />;
	return (
		<>
			{children ? children(content) : content}
			{lines.length > 10 && (
				<div className='ticket-text-disclosure'>
					<button
						type='button'
						aria-expanded={expanded}
						onClick={() => setExpandedSource(expanded ? undefined : text)}
					>
						{expanded ? "Show less" : "Show more"}
					</button>
				</div>
			)}
		</>
	);
};
