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

/** Model catalog lookup failed before an execution was attempted. */
export class AgentCatalogError extends AgentError {
	constructor(cause: unknown) {
		super("agent-unavailable", { cause });
	}
}
