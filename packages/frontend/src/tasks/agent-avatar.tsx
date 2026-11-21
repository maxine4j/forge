import type { AgentAvatarColour } from "@forge/contracts/task-agents";

export const AgentAvatar = ({ colour, name }: { colour: AgentAvatarColour; name?: string }) => (
	<span
		className='agent-avatar'
		data-colour={colour}
		role={name ? "img" : undefined}
		aria-label={name}
		aria-hidden={name ? undefined : true}
		title={name}
	>
		<span className='agent-avatar-head' />
	</span>
);
