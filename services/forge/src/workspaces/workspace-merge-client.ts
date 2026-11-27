import { gitShaSchema } from "@forge/contracts";

import type { IAgentWorkspaces } from "../agents/agent-service.ts";
import type { Actor } from "../auth/types.ts";
import { GitError, type IGitTransport } from "../repositories/git-transport.ts";
import { TicketError } from "../tickets/errors.ts";
import type { TicketMergeLocation } from "./types.ts";

export interface ITicketMergeClient {
	/** Read-only recovery check for a candidate already reachable from local main. */
	isMerged(actor: Actor, workspaceId: string, candidate: string, repository?: string): Promise<boolean>;
	/** Advances main to the persisted candidate only. Verifies both refs atomically; throws TicketError. */
	merge(
		actor: Actor,
		workspaceId: string,
		candidate: string,
		manual?: TicketMergeLocation,
	): Promise<"merged" | "rebase">;
	/** Requires clean, committed work on the owned branch, outside an unfinished rebase. */
	verify(actor: Actor, workspaceId: string, candidate: string): Promise<void>;
	candidate(actor: Actor, workspaceId: string, manual?: TicketMergeLocation): Promise<string>;
	base(actor: Actor, workspaceId: string): Promise<string>;
	head(actor: Actor, workspaceId: string): Promise<string>;
}

export class WorkspaceMergeClient implements ITicketMergeClient {
	constructor(
		private readonly workspaces: IAgentWorkspaces,
		private readonly git: IGitTransport,
	) {}
	async isMerged(actor: Actor, workspaceId: string, candidate: string, repository?: string): Promise<boolean> {
		try {
			gitShaSchema.parse(candidate);
			if (repository) return await this.isAncestor(repository, candidate, "refs/heads/main");
			const { path } = await this.workspaces.resolve(actor, workspaceId);
			const base = gitShaSchema.parse(
				(await this.git.run(["-C", path, "merge-base", "refs/heads/main", candidate])).trim(),
			);
			return base === candidate;
		} catch (cause) {
			throw new TicketError("ticket-unavailable", { cause });
		}
	}
	private async isAncestor(path: string, ancestor: string, tip: string): Promise<boolean> {
		try {
			await this.git.run(["-C", path, "merge-base", "--is-ancestor", ancestor, tip]);
			return true;
		} catch (cause) {
			if (cause instanceof GitError && cause.exitCode === 1) return false;
			throw cause;
		}
	}
	async base(actor: Actor, workspaceId: string): Promise<string> {
		const { workspace } = await this.workspaces.resolve(actor, workspaceId);
		if (!workspace.baseSha) throw new TicketError("ticket-unavailable");
		return workspace.baseSha;
	}
	async head(actor: Actor, workspaceId: string): Promise<string> {
		const { path } = await this.workspaces.resolve(actor, workspaceId);
		return gitShaSchema.parse((await this.git.run(["-C", path, "rev-parse", "--verify", "HEAD^{commit}"])).trim());
	}
	async verify(actor: Actor, workspaceId: string, candidate: string): Promise<void> {
		if ((await this.candidate(actor, workspaceId)) !== candidate) throw new TicketError("ticket-conflict");
	}
	async candidate(actor: Actor, workspaceId: string, manual?: TicketMergeLocation): Promise<string> {
		try {
			const { path, workspace } = manual ?? (await this.workspaces.resolve(actor, workspaceId));
			await manual?.assertGitIdle();
			const branch = (
				await this.git.run([
					"-C",
					path,
					...(manual ? ["rev-parse", "--symbolic-full-name"] : ["symbolic-ref"]),
					"HEAD",
				])
			).trim();
			const head = gitShaSchema.parse(
				(await this.git.run(["-C", path, "rev-parse", "--verify", "HEAD^{commit}"])).trim(),
			);
			if (branch !== `refs/heads/${workspace.branch}`)
				throw new TicketError(manual ? "ticket-ref-changed" : "ticket-conflict");
			if ((await this.git.run(["-C", path, "status", "--porcelain", "--untracked-files=all"])).trim())
				throw new TicketError(manual ? "ticket-worktree-dirty" : "ticket-conflict");
			if (
				manual
				&& (!workspace.baseSha
					|| head === workspace.baseSha
					|| !(await this.isAncestor(path, workspace.baseSha, head)))
			)
				throw new TicketError("ticket-no-commits");
			return head;
		} catch (cause) {
			if (cause instanceof TicketError) throw cause;
			throw new TicketError("ticket-unavailable", { cause });
		}
	}
	async merge(
		actor: Actor,
		workspaceId: string,
		candidate: string,
		manual?: TicketMergeLocation,
	): Promise<"merged" | "rebase"> {
		try {
			if (manual) {
				if ((await this.candidate(actor, workspaceId, manual)) !== candidate)
					throw new TicketError("ticket-ref-changed");
			} else await this.verify(actor, workspaceId, candidate);
			const { path, workspace } = manual ?? (await this.workspaces.resolve(actor, workspaceId));
			if ((await this.git.run(["-C", path, "status", "--porcelain", "--untracked-files=all"])).trim())
				throw new TicketError(manual ? "ticket-worktree-dirty" : "ticket-conflict");
			const readRef = async (ref: string) =>
				gitShaSchema.parse((await this.git.run(["-C", path, "rev-parse", "--verify", ref])).trim());
			const branch = `refs/heads/${workspace.branch}`;
			let main = await readRef("refs/heads/main");
			for (let attempt = 0; ; attempt++) {
				if ((await readRef(branch)) !== candidate)
					throw new TicketError(manual ? "ticket-ref-changed" : "ticket-conflict");
				const base = await this.git.run(["-C", path, "merge-base", main, candidate]).then(
					(value) => gitShaSchema.parse(value.trim()),
					(cause: unknown) => {
						if (manual && cause instanceof GitError && cause.exitCode === 1) return undefined;
						throw cause;
					},
				);
				// Git may already contain the candidate if Forge restarted before saving Done.
				if (!manual && base === candidate) return "merged";
				if (base !== main && base !== candidate) return "rebase";
				await manual?.assertGitIdle();
				try {
					const mainUpdate =
						base === candidate
							? `verify refs/heads/main ${main}`
							: `update refs/heads/main ${candidate} ${main}`;
					const noDeref = manual ? "option no-deref\n" : "";
					await this.git.run(
						["-C", path, "update-ref", "--stdin"],
						`start\n${noDeref}verify ${branch} ${candidate}\n${noDeref}${mainUpdate}\nprepare\ncommit\n`,
					);
					return "merged";
				} catch (cause) {
					if (manual && (!(cause instanceof GitError) || cause.exitCode === undefined)) throw cause;
					const latest = await readRef("refs/heads/main");
					if (manual) {
						if (latest !== candidate && (latest !== main || (await readRef(branch)) !== candidate))
							throw new TicketError("ticket-ref-changed", { cause });
						throw cause;
					}
					if (main === latest || attempt >= 2) throw cause;
					main = latest;
				}
			}
		} catch (cause) {
			if (cause instanceof TicketError) throw cause;
			throw new TicketError("ticket-unavailable", { cause });
		}
	}
}
