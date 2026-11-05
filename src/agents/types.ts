import type { AgentThread, AgentRequest } from "@forge/contracts/agents";
export interface AgentThreadRecord extends AgentThread {
	codexId?: string;
	requests: AgentRequest[];
	managed?: boolean;
}
