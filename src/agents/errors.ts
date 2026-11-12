export class AgentError extends Error {
	constructor(
		readonly code:
			| "invalid-request"
			| "unsupported-settings"
			| "agent-not-found"
			| "agent-conflict"
			| "agent-unavailable"
			| "agent-capacity",
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = "AgentError";
	}
}
