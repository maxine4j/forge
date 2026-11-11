import { join } from "node:path";

import { gitShaSchema } from "@forge/contracts";

import { GitError, type IGitTransport } from "./git-transport.ts";
import type { IRepositoryClient } from "./repository-client.ts";
import type { GithubSyncDrift, GithubSyncResult } from "./types.ts";

export interface IGithubSyncClient {
	/** Compares the observed main refs. Throws if either ref or the remote is unavailable. */
	status(id: string): Promise<GithubSyncDrift>;
	/** Updates main by expected head, then pushes a descendant of the observed remote head. */
	sync(id: string): Promise<GithubSyncResult>;
}

export const forgeGithubRemote = "https://github.com/maxine4j/forge.git";
const main = "refs/heads/main";

export class GithubSyncClient implements IGithubSyncClient {
	constructor(
		private readonly dataDirectory: string,
		private readonly repositories: IRepositoryClient,
		private readonly git: IGitTransport,
		private readonly remote: IGitTransport,
	) {}
	async status(id: string): Promise<GithubSyncDrift> {
		const { ahead, behind } = await this.compare(id);
		return { ahead, behind };
	}
	async sync(id: string): Promise<GithubSyncResult> {
		const { directory, localHead, remoteHead, ahead, behind } = await this.compare(id);
		let head = localHead;
		if (behind > 0) {
			if (ahead === 0) head = remoteHead;
			else {
				const merged = await this.merge(directory, localHead, remoteHead);
				if (merged === undefined) return { outcome: "conflict" };
				head = merged;
			}
		}
		const localUpdated = head !== localHead;
		try {
			if (localUpdated) await this.git.run(["-C", directory, "update-ref", main, head, localHead]);
		} catch (error) {
			if ((await this.mainHead(directory)) !== localHead) return { outcome: "changed" };
			throw error;
		}
		if ((await this.mainHead(directory)) !== head) return { outcome: "changed" };
		if (ahead > 0) {
			try {
				await this.remote.run([
					"-C",
					directory,
					"push",
					"--no-follow-tags",
					"--recurse-submodules=no",
					forgeGithubRemote,
					`${head}:${main}`,
				]);
			} catch {
				return { outcome: "push-failed", head, localUpdated };
			}
		}
		return { outcome: "synced", head };
	}
	private async compare(id: string) {
		await this.repositories.verify(id);
		const directory = join(this.dataDirectory, "repositories", `${id}.git`);
		const remoteRef = (await this.remote.run(["ls-remote", "--refs", forgeGithubRemote, main])).trim();
		const remoteHead = gitShaSchema.parse(/^([0-9a-f]+)\trefs\/heads\/main$/u.exec(remoteRef)?.at(1));
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
				forgeGithubRemote,
				remoteHead,
			]);
		}
		const localHead = await this.mainHead(directory);
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
		return { directory, localHead, remoteHead, ahead, behind };
	}
	private async mainHead(directory: string): Promise<string> {
		return gitShaSchema.parse((await this.git.run(["-C", directory, "rev-parse", "--verify", main])).trim());
	}
	private async merge(directory: string, localHead: string, remoteHead: string): Promise<string | undefined> {
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
					"Merge GitHub main",
				])
			).trim(),
		);
	}
}
