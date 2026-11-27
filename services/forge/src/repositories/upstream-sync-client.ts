import { join } from "node:path";

import { branchNameSchema, gitShaSchema } from "@forge/contracts";

import { GitError, type IGitTransport } from "./git-transport.ts";
import type { IRepositoryClient } from "./repository-client.ts";
import type { UpstreamSyncDrift, UpstreamSyncResult } from "./types.ts";

export interface IUpstreamSyncClient {
	/** Compares upstream's default branch. Throws if either ref or the remote is unavailable. */
	status(id: string): Promise<UpstreamSyncDrift>;
	/** Updates the captured branch by expected head, then pushes normally to the captured URL. */
	sync(id: string): Promise<UpstreamSyncResult>;
}

export class UpstreamSyncClient implements IUpstreamSyncClient {
	constructor(
		private readonly dataDirectory: string,
		private readonly repositories: IRepositoryClient,
		private readonly git: IGitTransport,
		private readonly remote: IGitTransport,
	) {}
	async status(id: string): Promise<UpstreamSyncDrift> {
		const { branch, ahead, behind } = await this.compare(id);
		return { branch, ahead, behind };
	}
	async sync(id: string): Promise<UpstreamSyncResult> {
		const { directory, url, branch, ref, localHead, remoteHead, ahead, behind } = await this.compare(id);
		let head = localHead;
		if (behind > 0) {
			if (ahead === 0) head = remoteHead;
			else {
				const merged = await this.merge(directory, branch, localHead, remoteHead);
				if (merged === undefined) return { outcome: "conflict" };
				head = merged;
			}
		}
		const localUpdated = head !== localHead;
		try {
			if (localUpdated) await this.git.run(["-C", directory, "update-ref", ref, head, localHead]);
		} catch (error) {
			if ((await this.branchHead(directory, ref)) !== localHead) return { outcome: "changed" };
			throw error;
		}
		if ((await this.branchHead(directory, ref)) !== head) return { outcome: "changed" };
		if (ahead > 0) {
			try {
				await this.remote.run([
					"-C",
					directory,
					"push",
					"--no-follow-tags",
					"--recurse-submodules=no",
					url,
					`${head}:${ref}`,
				]);
			} catch {
				return { outcome: "push-failed", head, localUpdated };
			}
		}
		return { outcome: "synced", head, branch };
	}
	private async compare(id: string) {
		await this.repositories.verify(id);
		const directory = join(this.dataDirectory, "repositories", `${id}.git`);
		const url = await this.repositories.upstreamUrl(id);
		const remoteRef = await this.remote.run(["ls-remote", "--symref", url, "HEAD"]);
		const branch = branchNameSchema.parse(/^ref: refs\/heads\/([^\s]+)\tHEAD$/mu.exec(remoteRef)?.at(1));
		const ref = `refs/heads/${branch}`;
		await this.git.run(["check-ref-format", ref]);
		const remoteHead = gitShaSchema.parse(/^([0-9a-f]+)\tHEAD$/mu.exec(remoteRef)?.at(1));
		const localHead = await this.branchHead(directory, ref);
		try {
			await this.git.run(["-C", directory, "cat-file", "-e", `${remoteHead}^{commit}`]);
		} catch (error) {
			if (!(error instanceof GitError) || error.exitCode === undefined) throw error;
			await this.remote.run([
				"-C",
				directory,
				"fetch",
				"--no-tags",
				"--no-recurse-submodules",
				"--no-write-fetch-head",
				"--refmap=",
				url,
				remoteHead,
			]);
		}
		const counts = await this.git.run([
			"-C",
			directory,
			"rev-list",
			"--left-right",
			"--count",
			`${localHead}...${remoteHead}`,
		]);
		const match = /^(\d+)\t(\d+)$/u.exec(counts.trim());
		const ahead = Number(match?.at(1));
		const behind = Number(match?.at(2));
		if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) throw new GitError();
		return { directory, url, branch, ref, localHead, remoteHead, ahead, behind };
	}
	private async branchHead(directory: string, ref: string): Promise<string> {
		return gitShaSchema.parse(
			(await this.git.run(["-C", directory, "rev-parse", "--verify", `${ref}^{commit}`])).trim(),
		);
	}
	private async merge(
		directory: string,
		branch: string,
		localHead: string,
		remoteHead: string,
	): Promise<string | undefined> {
		let tree: string;
		try {
			await this.git.run(["-C", directory, "merge-base", localHead, remoteHead]);
			tree = gitShaSchema.parse(
				(await this.git.run(["-C", directory, "merge-tree", "--write-tree", localHead, remoteHead])).trim(),
			);
		} catch (error) {
			if (error instanceof GitError && error.exitCode === 1) return undefined;
			throw error;
		}
		return gitShaSchema.parse(
			(
				await this.git.run([
					"-C",
					directory,
					"-c",
					"user.name=Forge",
					"-c",
					"user.email=forge@localhost",
					"-c",
					"commit.gpgSign=false",
					"commit-tree",
					tree,
					"-p",
					localHead,
					"-p",
					remoteHead,
					"-m",
					`Merge upstream ${branch}`,
				])
			).trim(),
		);
	}
}
