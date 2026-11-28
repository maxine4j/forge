import type { Ticket } from "@forge/contracts/tickets";

import { AgentAvatar } from "./agent-avatar.tsx";

export type TicketActivity = "resetting" | "attention" | "failed" | NonNullable<Ticket["agentStatus"]>;

export const TicketActivityIcon = ({ activity }: { activity: TicketActivity }) =>
	activity === "resetting" ? (
		<span
			className='ticket-agent-status is-working'
			role='img'
			aria-label='Cancellation and cleanup pending'
			title='Cancellation and cleanup pending'
		>
			↻
		</span>
	) : activity === "attention" ? (
		<span
			className='ticket-agent-status ticket-attention'
			role='img'
			aria-label='Action required'
			title='Action required'
		/>
	) : (
		<svg
			className={`ticket-agent-status ${activity === "working" ? "is-working" : activity === "failed" ? "ticket-agent-failed" : ""}`}
			role='img'
			aria-label={`Agent ${activity}`}
			viewBox='0 0 16 16'
			fill='none'
			stroke='currentColor'
			strokeWidth='1.5'
		>
			<title>{`Agent ${activity}`}</title>
			{activity === "queued" ? (
				<>
					<circle cx='8' cy='8' r='6' />
					<path d='M8 4v4l3 2' />
				</>
			) : activity === "working" ? (
				<path d='M8 2a6 6 0 1 1-6 6' strokeLinecap='round' />
			) : (
				<>
					<circle cx='8' cy='8' r='6' />
					<path d='M6 6l4 4m0-4-4 4' strokeLinecap='round' />
				</>
			)}
		</svg>
	);

export const TicketIndicator = ({ ticket }: { ticket: Ticket }) => {
	const activity = ticket.resetting ? "resetting" : ticket.needsAttention ? "attention" : ticket.agentStatus;
	const icon = activity && <TicketActivityIcon activity={activity} />;
	return ticket.assignee ? (
		<span className='ticket-indicators'>
			{icon}
			<AgentAvatar
				colour={ticket.assignee.avatarColour}
				symbol={ticket.assignee.avatarSymbol}
				name={ticket.assignee.name}
			/>
		</span>
	) : (
		icon
	);
};
