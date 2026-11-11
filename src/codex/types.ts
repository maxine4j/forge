import type { AgentContextWindow, AgentItem, AgentRequest, AgentStatus } from "@forge/contracts/agents";
export type ExecutionReconciliation =
	| { state: "active"; turnId: string }
	| { state: "inactive" | "missing" }
	| { state: "unavailable" };
export interface AgentRuntimeView {
	status: AgentStatus;
	turnId?: string;
	plan?: string;
	items: AgentItem[];
	requests: AgentRequest[];
	truncated: boolean;
	contextWindow?: AgentContextWindow;
}
