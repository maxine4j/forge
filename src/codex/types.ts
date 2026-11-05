import type { AgentItem, AgentRequest, AgentStatus } from "@forge/contracts/agents";
export interface AgentRuntimeView {
	status: AgentStatus;
	turnId?: string;
	items: AgentItem[];
	requests: AgentRequest[];
	truncated: boolean;
}
