import type { Actor } from "../auth/types.ts";
import type { ITerminalService } from "../terminal/terminal-service.ts";
import { WorkspaceError } from "./errors.ts";
import type { IAbandonedWorkspaceCleanup } from "./workspace-service.ts";

/** Agent settlement is the caller's responsibility; terminals stop before files disappear. */
export class AbandonedWorkspaceCleanup implements IAbandonedWorkspaceCleanup {
	constructor(
		private readonly terminals: Pick<ITerminalService, "status" | "close">,
		private readonly workspaces: IAbandonedWorkspaceCleanup,
	) {}
	async cleanupAbandoned(actor: Actor, id: string): Promise<void> {
		const terminal = await this.terminals.status(actor, id).catch((err: unknown) => {
			if (err instanceof WorkspaceError && err.code === "workspace-not-found") return undefined;
			throw err;
		});
		if (terminal) await this.terminals.close(actor, terminal.id);
		await this.workspaces.cleanupAbandoned(actor, id);
	}
}
