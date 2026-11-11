import type { AgentStatus } from "@forge/contracts/agents";
import { defaultConcurrentAgents } from "@forge/contracts/tickets";

import { AgentError } from "./errors.ts";

export interface IAgentExecutionPool {
	claim(id: string): void;
	observe(id: string, status: AgentStatus): void;
	available(): boolean;
	activeIds(): string[];
}
export interface IAgentExecutionLimit {
	setLimit(limit: number): void;
}
export class AgentExecutionPool implements IAgentExecutionPool, IAgentExecutionLimit {
	private readonly active = new Set<string>();
	private limit = defaultConcurrentAgents;
	constructor(private readonly onRelease: () => void = () => {}) {}
	claim(id: string): void {
		if (!this.active.has(id) && !this.available()) throw new AgentError("agent-capacity");
		this.active.add(id);
	}
	observe(id: string, status: AgentStatus): void {
		if (["creating", "running", "waiting", "uncertain"].includes(status)) this.active.add(id);
		else if (this.active.delete(id)) this.onRelease();
	}
	available(): boolean {
		return this.active.size < this.limit;
	}
	activeIds(): string[] {
		return [...this.active];
	}
	setLimit(limit: number): void {
		const hadCapacity = this.available();
		this.limit = limit;
		if (!hadCapacity && this.available()) this.onRelease();
	}
}
