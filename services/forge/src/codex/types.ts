import type {
	AgentContextWindow,
	AgentItem,
	AgentRequest,
	AgentStatus,
	AgentTurnFailure,
} from "@forge/contracts/agents";
export type ExecutionReconciliation =
	| { state: "active"; turnId: string }
	| { state: "inactive" | "missing" }
	| { state: "unavailable" };

export interface TurnContextSample {
	used: number;
	peak: number;
	max?: number;
	crossed: boolean;
}

export interface AgentRuntimeView {
	status: AgentStatus;
	turnId?: string;
	plan?: string;
	finalAnswer?: string;
	items: AgentItem[];
	requests: AgentRequest[];
	truncated: boolean;
	contextWindow?: AgentContextWindow;
	turnFailure?: AgentTurnFailure;
}
