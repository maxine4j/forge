export class PullRequestError extends Error {
	constructor(
		readonly code:
			| "invalid-request"
			| "pull-request-not-found"
			| "pull-request-unavailable"
			| "revision-conflict"
			| "no-changes"
			| "pull-request-closed",
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = "PullRequestError";
	}
}
