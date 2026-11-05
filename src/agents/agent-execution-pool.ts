import type { AgentStatus } from "@forge/contracts/agents";

import { AgentError } from "./errors.ts";

export interface IAgentExecutionPool {
	claim(id: string): void;
	observe(id: string, status: AgentStatus): void;
	available(): boolean;
}
export class AgentExecutionPool implements IAgentExecutionPool {
	private readonly active = new Set<string>();
	claim(id: string): void {
		if (!this.active.has(id) && !this.available()) throw new AgentError("agent-capacity");
		this.active.add(id);
	}
	observe(id: string, status: AgentStatus): void {
		if (["creating", "running", "waiting", "uncertain"].includes(status)) this.active.add(id);
		else this.active.delete(id);
	}
	available(): boolean {
		return this.active.size < 3;
	}
}
