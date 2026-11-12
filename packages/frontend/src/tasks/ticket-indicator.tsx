import type { Ticket } from "@forge/contracts/tickets";
export const TicketIndicator = ({ ticket }: { ticket: Ticket }) =>
	ticket.needsAttention ? (
		<span
			className='ticket-agent-status ticket-attention'
			role='img'
			aria-label='Action required'
			title='Action required'
		/>
	) : ticket.agentStatus ? (
		<svg
			className={`ticket-agent-status ${ticket.agentStatus === "working" ? "is-working" : ""}`}
			role='img'
			aria-label={ticket.agentStatus === "queued" ? "Agent queued" : "Agent working"}
			viewBox='0 0 16 16'
			fill='none'
			stroke='currentColor'
			strokeWidth='1.5'
		>
			<title>{ticket.agentStatus === "queued" ? "Agent queued" : "Agent working"}</title>
			{ticket.agentStatus === "queued" ? (
				<>
					<circle cx='8' cy='8' r='6' />
					<path d='M8 4v4l3 2' />
				</>
			) : (
				<path d='M8 2a6 6 0 1 1-6 6' strokeLinecap='round' />
			)}
		</svg>
	) : null;
