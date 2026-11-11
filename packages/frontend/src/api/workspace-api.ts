export interface IWorkspaceApi {
	read<T>(path: string, schema: { parse(value: unknown): T }, method?: string, body?: unknown): Promise<T>;
}

export class WorkspaceApi implements IWorkspaceApi {
	constructor(private readonly request: typeof fetch) {}
	async read<T>(path: string, schema: { parse(value: unknown): T }, method = "GET", body?: unknown): Promise<T> {
		const response = await this.request(`/api/${path}`, {
			method,
			credentials: "same-origin",
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
				"agent-capacity":
					"All agent slots are occupied. Retry when an agent finishes. Your draft is preserved.",
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
				"invalid-request": "Check the supplied values.",
				"workspace-not-found": "Project files no longer exist. Reopen the project.",
				"workspace-conflict":
					"The branch changed. Your drafts are preserved. Copy them before discarding drafts to reload the branch.",
				"workspace-unavailable": "Project files unavailable. Retry opening files.",
				"github-sync-unconfigured": "GitHub sync is unavailable for this project.",
				"github-sync-unavailable":
					"Could not sync with GitHub. Check that both main branches are available and try again.",
				"github-sync-busy": "GitHub sync is already running. Try again when it finishes.",
				"github-sync-conflict": "Forge and GitHub main cannot be merged automatically.",
				"github-sync-changed": "Forge main changed during sync. Check the updated counts and try again.",
				"github-sync-push-failed":
					"Could not push to GitHub. Check the connected account and repository access.",
				"github-sync-push-failed-local-updated":
					"Forge main was updated, but the push to GitHub failed. Check the connected account and repository access.",
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
