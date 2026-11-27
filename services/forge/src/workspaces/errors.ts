export type WorkspaceErrorCode =
	| "invalid-request"
	| "workspace-not-found"
	| "workspace-unavailable"
	| "workspace-conflict"
	| "file-not-found"
	| "file-conflict"
	| "file-unsupported";
export class WorkspaceError extends Error {
	constructor(
		readonly code: WorkspaceErrorCode,
		options?: ErrorOptions,
	) {
		super(code, options);
		this.name = "WorkspaceError";
	}
}
