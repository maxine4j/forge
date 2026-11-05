import { gitShaSchema } from "@forge/contracts";
import type { PullRequestDiff } from "@forge/contracts/pull-requests";

import type { Actor } from "../auth/types.ts";
import type { IGitDiffClient } from "../repositories/git-diff-client.ts";
import type { IGitBinaryTransport } from "../repositories/git-transport.ts";
import type { WorkspaceLocation } from "../workspaces/types.ts";
import { PullRequestError } from "./errors.ts";
import type { PullRequestSource } from "./types.ts";

export interface IPullRequestWorkspaces {
	resolve(actor: Actor, id: string): Promise<WorkspaceLocation>;
}
export interface IPullRequestClient {
	/** Resolves an owned ready workspace; only read-only Git, exact immutable comparisons.
	 * Ref movement during observation fails closed. Throws PullRequestError. */
	inspect(actor: Actor, workspaceId: string): Promise<PullRequestSource>;
	diff(actor: Actor, workspaceId: string): Promise<PullRequestDiff>;
}
export class PullRequestClient implements IPullRequestClient {
	constructor(
		private readonly workspaces: IPullRequestWorkspaces,
		private readonly git: IGitBinaryTransport,
		private readonly differences: IGitDiffClient,
	) {}
	async inspect(actor: Actor, workspaceId: string): Promise<PullRequestSource> {
		try {
			const { workspace, path } = await this.workspaces.resolve(actor, workspaceId);
			if (
				workspace.id !== workspaceId
				|| workspace.status !== "ready"
				|| workspace.branch !== `forge/workspace/${workspaceId}`
			)
				throw new Error("Workspace identity");
			const revision = await this.revision(path, workspace.branch);
			const hasChanges =
				(await this.git.run(["-C", path, "rev-parse", `${revision.mergeBase}^{tree}`])).trim()
				!== (await this.git.run(["-C", path, "rev-parse", `${revision.head}^{tree}`])).trim();
			const after = await this.revision(path, workspace.branch);
			if (after.head !== revision.head || after.baseSha !== revision.baseSha) throw new Error("Revision moved");
			return { projectId: workspace.projectId, workspaceId, branch: workspace.branch, revision, hasChanges };
		} catch (cause) {
			throw new PullRequestError("pull-request-unavailable", { cause });
		}
	}
	async diff(actor: Actor, workspaceId: string): Promise<PullRequestDiff> {
		try {
			const source = await this.inspect(actor, workspaceId);
			const { path } = await this.workspaces.resolve(actor, workspaceId);
			const diff = await this.differences.section(path, [source.revision.mergeBase, source.revision.head]);
			const after = await this.inspect(actor, workspaceId);
			if (source.revision.head !== after.revision.head || source.revision.baseSha !== after.revision.baseSha)
				throw new Error("Revision moved");
			return {
				comparison: "merge-base(main, workspace)..workspace (committed)",
				revision: source.revision,
				diff,
			};
		} catch (cause) {
			throw new PullRequestError("pull-request-unavailable", { cause });
		}
	}
	private async revision(path: string, branch: string): Promise<PullRequestSource["revision"]> {
		if ((await this.git.run(["-C", path, "symbolic-ref", "HEAD"])).trim() !== `refs/heads/${branch}`)
			throw new Error("Protected branch");
		const head = gitShaSchema.parse(
			(await this.git.run(["-C", path, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`])).trim(),
		);
		const baseSha = gitShaSchema.parse(
			(await this.git.run(["-C", path, "rev-parse", "--verify", "refs/heads/main^{commit}"])).trim(),
		);
		const mergeBase = gitShaSchema.parse((await this.git.run(["-C", path, "merge-base", baseSha, head])).trim());
		return { head, baseSha, mergeBase };
	}
}
