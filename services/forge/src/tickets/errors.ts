export class TicketError extends Error {
	constructor(
		public readonly code:
			| "invalid-request"
			| "unsupported-settings"
			| "ticket-not-found"
			| "ticket-conflict"
			| "ticket-workspace-invalid"
			| "ticket-worktree-dirty"
			| "ticket-git-in-progress"
			| "ticket-ref-changed"
			| "ticket-branch-diverged"
			| "ticket-no-commits"
			| "ticket-unavailable",
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = "TicketError";
	}
}
