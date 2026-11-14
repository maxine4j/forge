import type { ComponentProps, ReactNode } from "react";
import { Link } from "react-router";

export const SectionTabs = ({ className = "", ...props }: ComponentProps<"div">) => (
	<div {...props} role='tablist' className={`section-tabs section-tabs-toolbar ${className}`} />
);

type TabProps = {
	selected: boolean;
	panel: string;
	icon?: ReactNode;
};
type SectionTabProps = TabProps
	& (({ to: string } & ComponentProps<typeof Link>) | ({ to?: never } & ComponentProps<"button">));

export const SectionTab = ({ selected, panel, icon, children, ...props }: SectionTabProps) => {
	const shared = { role: "tab", "aria-selected": selected, "aria-controls": panel };
	const content = (
		<>
			{icon}
			{children}
		</>
	);
	return props.to !== undefined ? (
		<Link {...props} {...shared}>
			{content}
		</Link>
	) : (
		<button type='button' {...props} {...shared}>
			{content}
		</button>
	);
};
