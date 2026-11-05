import { gitShaSchema } from "@forge/contracts";

import type { IAgentWorkspaces } from "../agents/agent-service.ts";
import type { Actor } from "../auth/types.ts";
import type { IGitTransport } from "../repositories/git-transport.ts";
import { TicketError } from "../tickets/errors.ts";

export interface ITicketMergeClient {
	/** Advances main to the persisted candidate only. Verifies both refs atomically; throws TicketError. */
	merge(actor: Actor, workspaceId: string, candidate: string): Promise<"merged" | "rebase">;
	/** Requires clean, committed work on the owned branch, outside an unfinished rebase. */
	verify(actor: Actor, workspaceId: string, candidate: string): Promise<void>;
	base(actor: Actor, workspaceId: string): Promise<string>;
}

export class WorkspaceMergeClient implements ITicketMergeClient {
	constructor(
		private readonly workspaces: IAgentWorkspaces,
		private readonly git: IGitTransport,
	) {}
	async base(actor: Actor, workspaceId: string): Promise<string> {
		const { workspace } = await this.workspaces.resolve(actor, workspaceId);
		if (!workspace.baseSha) throw new TicketError("ticket-unavailable");
		return workspace.baseSha;
	}
	async verify(actor: Actor, workspaceId: string, candidate: string): Promise<void> {
		try {
			const { path, workspace } = await this.workspaces.resolve(actor, workspaceId);
			gitShaSchema.parse(candidate);
			const branch = (await this.git.run(["-C", path, "symbolic-ref", "HEAD"])).trim();
			const head = (await this.git.run(["-C", path, "rev-parse", "--verify", "HEAD^{commit}"])).trim();
			if (
				branch !== `refs/heads/${workspace.branch}`
				|| head !== candidate
				|| (await this.git.run(["-C", path, "status", "--porcelain", "--untracked-files=all"])).trim()
			)
				throw new TicketError("ticket-conflict");
		} catch (cause) {
			if (cause instanceof TicketError) throw cause;
			throw new TicketError("ticket-unavailable", { cause });
		}
	}
	async merge(actor: Actor, workspaceId: string, candidate: string): Promise<"merged" | "rebase"> {
		try {
			await this.verify(actor, workspaceId, candidate);
			const { path, workspace } = await this.workspaces.resolve(actor, workspaceId);
			if ((await this.git.run(["-C", path, "status", "--porcelain", "--untracked-files=all"])).trim())
				throw new TicketError("ticket-conflict");
			const main = gitShaSchema.parse(
				(await this.git.run(["-C", path, "rev-parse", "--verify", "refs/heads/main"])).trim(),
			);
			const head = gitShaSchema.parse(
				(await this.git.run(["-C", path, "rev-parse", "--verify", `refs/heads/${workspace.branch}`])).trim(),
			);
			if (head !== candidate) throw new TicketError("ticket-conflict");
			const base = gitShaSchema.parse((await this.git.run(["-C", path, "merge-base", main, head])).trim());
			// A crash after updating Git but before recording Done must be recoverable,
			// including when later approved work has already advanced main again.
			if (base === candidate) return "merged";
			if (base !== main) return "rebase";
			await this.git.run(
				["-C", path, "update-ref", "--stdin"],
				`start\nverify refs/heads/${workspace.branch} ${candidate}\nupdate refs/heads/main ${candidate} ${main}\nprepare\ncommit\n`,
			);
			return "merged";
		} catch (cause) {
			if (cause instanceof TicketError) throw cause;
			throw new TicketError("ticket-unavailable", { cause });
		}
	}
}
