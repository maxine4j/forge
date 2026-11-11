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
	candidate(actor: Actor, workspaceId: string): Promise<string>;
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
		if ((await this.candidate(actor, workspaceId)) !== candidate) throw new TicketError("ticket-conflict");
	}
	async candidate(actor: Actor, workspaceId: string): Promise<string> {
		try {
			const { path, workspace } = await this.workspaces.resolve(actor, workspaceId);
			const branch = (await this.git.run(["-C", path, "symbolic-ref", "HEAD"])).trim();
			const head = gitShaSchema.parse(
				(await this.git.run(["-C", path, "rev-parse", "--verify", "HEAD^{commit}"])).trim(),
			);
			if (
				branch !== `refs/heads/${workspace.branch}`
				|| (await this.git.run(["-C", path, "status", "--porcelain", "--untracked-files=all"])).trim()
			)
				throw new TicketError("ticket-conflict");
			return head;
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
			const readRef = async (ref: string) =>
				gitShaSchema.parse((await this.git.run(["-C", path, "rev-parse", "--verify", ref])).trim());
			const branch = `refs/heads/${workspace.branch}`;
			let main = await readRef("refs/heads/main");
			for (let attempt = 0; ; attempt++) {
				if ((await readRef(branch)) !== candidate) throw new TicketError("ticket-conflict");
				const base = gitShaSchema.parse(
					(await this.git.run(["-C", path, "merge-base", main, candidate])).trim(),
				);
				// Git may already contain the candidate if Forge restarted before saving Done.
				if (base === candidate) return "merged";
				if (base !== main) return "rebase";
				try {
					await this.git.run(
						["-C", path, "update-ref", "--stdin"],
						`start\nverify ${branch} ${candidate}\nupdate refs/heads/main ${candidate} ${main}\nprepare\ncommit\n`,
					);
					return "merged";
				} catch (cause) {
					const latest = await readRef("refs/heads/main");
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
