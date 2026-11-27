import type { AgentStatus } from "@forge/contracts/agents";

export interface IAgentExecutionTracker {
	claim(id: string): void;
	observe(id: string, status: AgentStatus): void;
	activeIds(): string[];
}
export class AgentExecutionTracker implements IAgentExecutionTracker {
	private readonly active = new Set<string>();
	constructor(private readonly onRelease: () => void = () => {}) {}
	claim(id: string): void {
		this.active.add(id);
	}
	observe(id: string, status: AgentStatus): void {
		if (["creating", "running", "waiting", "uncertain"].includes(status)) this.active.add(id);
		else if (this.active.delete(id)) this.onRelease();
	}
	activeIds(): string[] {
		return [...this.active];
	}
}
