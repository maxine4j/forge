import type { AgentContextWindow, AgentThread, AgentRequest } from "@forge/contracts/agents";
import type { InferenceProvider } from "@forge/contracts/settings";
export interface AgentThreadRecord extends AgentThread {
	codexId?: string;
	requests: AgentRequest[];
	managed?: boolean;
	contextWindow?: AgentContextWindow;
	provider?: InferenceProvider;
}
