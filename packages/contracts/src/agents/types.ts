export type AgentStatus =
	| "creating"
	| "idle"
	| "running"
	| "waiting"
	| "completed"
	| "interrupted"
	| "failed"
	| "uncertain";
export interface AgentItem {
	kind?: "plan";
	id: string;
	role: "user" | "assistant" | "activity";
	text: string;
	title?: string;
	status?: "running" | "completed" | "failed" | "interrupted";
}
export interface AgentSettings {
	model?: string;
	reasoningEffort?: string;
	permissions?: "ask" | "approve-for-me" | "full-access";
}
export interface AgentOptions {
	supportsAutoReview?: false;
	models: {
		id: string;
		name: string;
		isDefault: boolean;
		supportedReasoningEfforts?: { reasoningEffort: string; description: string }[];
		defaultReasoningEffort?: string;
	}[];
	skills: { name: string; description: string }[];
	defaultModel?: string;
	defaultReasoningEffort?: string;
}
export interface AgentQuestion {
	id: string;
	question: string;
	secret: boolean;
	options: string[];
}
export interface AgentRequest {
	id: string;
	kind: "command" | "file" | "input";
	description: string;
	questions: AgentQuestion[];
}
export interface AgentThread extends AgentSettings {
	id: string;
	projectId: string;
	workspaceId: string;
	title: string;
	createdAt: string;
	status: AgentStatus;
	turnId?: string;
}
export interface AgentContextWindow {
	used: number;
	max: number;
}
export type AgentTurnFailure = "provider-request" | "context-window" | "other";
export interface AgentView {
	thread: AgentThread;
	items: AgentItem[];
	requests: AgentRequest[];
	truncated: boolean;
	contextWindow?: AgentContextWindow;
	turnFailure?: AgentTurnFailure;
}
export interface AgentReply {
	requestId: string;
	decision?: "accept" | "decline";
	answers?: Record<string, string>;
}
