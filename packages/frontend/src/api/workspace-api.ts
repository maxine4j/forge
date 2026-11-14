export interface IWorkspaceApi {
	read<T>(
		path: string,
		schema: { parse(value: unknown): T },
		method?: string,
		body?: unknown,
		signal?: AbortSignal,
	): Promise<T>;
}

export class WorkspaceApi implements IWorkspaceApi {
	constructor(private readonly request: typeof fetch) {}
	async read<T>(
		path: string,
		schema: { parse(value: unknown): T },
		method = "GET",
		body?: unknown,
		signal?: AbortSignal,
	): Promise<T> {
		const response = await this.request(`/api/${path}`, {
			method,
			credentials: "same-origin",
			signal,
			headers: {
				accept: "application/json",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}).catch(() => {
			throw new Error("Cannot reach Forge. Check your connection and retry.");
		});
		const value: unknown = await response.json().catch(() => undefined);
		if (!response.ok) {
			const error = typeof value === "object" && value !== null && "error" in value ? value.error : undefined;
			const messages: Record<string, string> = {
				"pipeline-invalid": "Branch, workflow or event is invalid. Refresh the pipeline selection.",
				"pipeline-busy": "Another pipeline is running. Wait for it to finish before retrying.",
				"pipeline-not-found": "Pipeline run no longer exists. Refresh recent runs.",
				"pipeline-unavailable": "Pipelines are unavailable. Retry after Forge restarts.",
				"docker-busy": "Docker cleanup is already running. Refresh to follow its progress.",
				"docker-unavailable": "Docker is unavailable. Refresh and retry.",
				"unsupported-settings":
					"The selected model or thinking level is unavailable, or the provider does not support the permission mode. Use Default for the model or thinking level, or choose an available permission mode. Your draft is preserved.",
				"agent-capacity":
					"Agent submission was stopped. Retry when the stop operation finishes. Your draft is preserved.",
				"agent-not-found": "Chat no longer exists. Refresh the chat list.",
				"agent-conflict": "Chat changed. Refresh its status before trying again. Your draft is preserved.",
				"agent-unavailable":
					"Chat unavailable. Check the connection and account. Your draft is preserved; load history before sending again.",
				"mock-read-only": "This preview is read-only. Changes require a running Forge backend.",
				"access-denied": "Sign in through PaaS as the configured owner.",
				"ticket-not-found": "Ticket no longer exists. Refresh the board.",
				"ticket-conflict":
					"This transition is not available. Wait for the current work or plan before retrying.",
				"ticket-unavailable": "Tickets are unavailable. Retry or check the server logs.",
				"epic-not-found": "Epic no longer exists. Refresh the backlog.",
				"epic-unavailable": "Epics are unavailable. Refresh and retry. Your edits are preserved.",
				"invalid-request": "Check the supplied values.",
				"settings-unavailable": "Forge settings are unavailable. Check the connection and retry.",
				"workspace-not-found": "Repository files no longer exist. Reopen the repository.",
				"workspace-conflict":
					"The branch changed. Your drafts are preserved. Copy them before discarding drafts to reload the branch.",
				"workspace-unavailable": "Repository files unavailable. Retry opening files.",
				"upstream-sync-unconfigured": "Upstream sync is unavailable for this repository.",
				"upstream-sync-unavailable":
					"Could not sync with upstream. Check that its default branch exists locally and the remote is readable and try again.",
				"upstream-sync-busy": "Upstream sync is already running. Try again when it finishes.",
				"upstream-sync-conflict": "Forge and upstream cannot be merged automatically.",
				"upstream-sync-changed":
					"The local branch changed during sync. Check the updated counts and try again.",
				"upstream-sync-push-failed":
					"Could not push to upstream. Check the repository access and authentication.",
				"upstream-sync-push-failed-local-updated":
					"The local branch was updated, but the push to upstream failed. Check the repository access and authentication.",
				"file-conflict": "Your draft is preserved. Compare the server version before retrying.",
				"file-not-found": "Refresh the file tree.",
				"file-unsupported": "The file is binary, too large, or uses an unsupported path.",
				"revision-conflict": "Source refs changed. Refresh review before retrying.",
				"no-changes": "Commit your changes before creating a PR.",
				"pull-request-closed": "Reopen the PR before reviewing.",
				"pull-request-unavailable":
					"The source files are unavailable. Metadata and discussion remain available.",
				"pull-request-not-found": "Refresh the PR list.",
				"terminal-unavailable": "Shell unavailable. Check the supported Linux runtime and server logs.",
				"terminal-not-found": "Refresh shell status before retrying.",
				"terminal-conflict": "A live shell already exists. Refresh status and reconnect.",
				"terminal-capacity": "Close unused shells and retry.",
			};
			if (
				error === "pipeline-invalid"
				&& typeof value === "object"
				&& value !== null
				&& "message" in value
				&& typeof value.message === "string"
			)
				throw new Error(value.message);
			throw new Error(
				typeof error === "string" && Object.hasOwn(messages, error)
					? messages[error]
					: "Request failed. Refresh and try again.",
			);
		}
		try {
			return schema.parse(value);
		} catch {
			throw new Error("Unexpected server response. Refresh and try again.");
		}
	}
}
