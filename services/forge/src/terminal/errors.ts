export class TerminalError extends Error {
	constructor(
		readonly code:
			| "invalid-request"
			| "terminal-not-found"
			| "terminal-conflict"
			| "terminal-unavailable"
			| "terminal-capacity",
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = "TerminalError";
	}
}
