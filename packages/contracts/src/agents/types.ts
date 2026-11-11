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
	permissions?: "ask" | "approve-for-me" | "full-access";
}
export interface AgentOptions {
	models: { id: string; name: string; isDefault: boolean }[];
	skills: { name: string; description: string }[];
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
export interface AgentView {
	thread: AgentThread;
	items: AgentItem[];
	requests: AgentRequest[];
	truncated: boolean;
	contextWindow?: AgentContextWindow;
}
export interface AgentReply {
	requestId: string;
	decision?: "accept" | "decline";
	answers?: Record<string, string>;
}
