export class TicketError extends Error {
	constructor(
		public readonly code: "invalid-request" | "ticket-not-found" | "ticket-conflict" | "ticket-unavailable",
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = "TicketError";
	}
}
