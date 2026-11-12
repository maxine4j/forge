export class EpicError extends Error {
	constructor(
		public readonly code: "invalid-request" | "epic-not-found" | "epic-unavailable",
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = "EpicError";
	}
}
