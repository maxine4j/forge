import { join } from "node:path";

import {
	branchNameSchema,
	filePathSchema,
	gitShaSchema,
	projectIdSchema,
	repositoryBranchesSchema,
	repositoryCommitSchema,
	repositoryTreeSchema,
	repositoryCommitInputSchema,
	type RepositoryCommitInput,
	treePathSchema,
	type RepositoryBranch,
	type RepositoryTree,
	type RepositoryFile,
	type RepositoryHistory,
	type RepositoryCommit,
} from "@forge/contracts";
import type { CommitDetail, CommitPatch } from "@forge/contracts";

import { WorkspaceError } from "../workspaces/errors.ts";
import { CommitReader } from "./commit-reader.ts";
import type { IGitTransport, IGitBinaryTransport } from "./git-transport.ts";
import type { IRepositoryClient } from "./repository-client.ts";

export interface IRepositoryBrowserClient {
	commitDetail(id: string, sha: string): Promise<CommitDetail>;
	commitPatch(id: string, sha: string, path: string, ignoreWhitespace: boolean): Promise<CommitPatch>;
	/** Commits text drafts atomically without checkout writes. Stale heads throw workspace-conflict; invalid/unsupported inputs and infrastructure failures use safe WorkspaceError codes. */
	commit(id: string, input: RepositoryCommitInput): Promise<{ head: string }>;
	/** Bounded read operations. Throws WorkspaceError with safe invalid-request, file-not-found, file-unsupported or workspace-unavailable codes. */
	branches(id: string): Promise<RepositoryBranch[]>;
	tree(id: string, branch: string, path: string): Promise<RepositoryTree>;
	file(id: string, branch: string, path: string): Promise<RepositoryFile>;
	history(id: string, branch: string, offset: number, limit: number): Promise<RepositoryHistory>;
}
export class RepositoryBrowserClient implements IRepositoryBrowserClient {
	async commitDetail(id: string, sha: string): Promise<CommitDetail> {
		return this.boundary(async () => {
			await this.verify(id);
			return new CommitReader((args) => this.run(id, args)).detail(sha);
		});
	}
	async commitPatch(id: string, sha: string, path: string, ignoreWhitespace: boolean): Promise<CommitPatch> {
		return this.boundary(async () => {
			await this.verify(id);
			return new CommitReader(
				(args) => this.run(id, args),
				this.git.runBytes
					? (args) =>
							this.git.runBytes!([
								"--literal-pathspecs",
								"-C",
								join(this.root, "repositories", `${id}.git`),
								...args,
							])
					: undefined,
			).patch(sha, path, ignoreWhitespace);
		});
	}
	constructor(
		private readonly root: string,
		private readonly git: IGitTransport & Partial<IGitBinaryTransport>,
		private readonly repositories: IRepositoryClient,
	) {}
	async commit(id: string, input: RepositoryCommitInput): Promise<{ head: string }> {
		return this.boundary(async () => {
			const parsed = repositoryCommitInputSchema.safeParse(input);
			if (!parsed.success) throw new WorkspaceError("invalid-request");
			const { branch, expectedHead, message, files } = parsed.data;
			if ((await this.head(id, branch)) !== expectedHead) throw new WorkspaceError("workspace-conflict");
			const original = (await this.run(id, ["rev-parse", `${expectedHead}^{tree}`])).trim();
			const tree = await this.editTree(id, original, files);
			if (tree === original) throw new WorkspaceError("invalid-request");
			const head = gitShaSchema.parse(
				(
					await this.run(id, [
						"-c",
						"user.name=Forge owner",
						"-c",
						"user.email=owner@forge.local",
						"commit-tree",
						tree,
						"-p",
						expectedHead,
						"-m",
						message,
					])
				).trim(),
			);
			try {
				await this.run(id, ["update-ref", `refs/heads/${branch}`, head, expectedHead]);
			} catch (cause) {
				if ((await this.head(id, branch)) !== expectedHead)
					throw new WorkspaceError("workspace-conflict", { cause });
				throw cause;
			}
			return { head };
		});
	}
	async branches(id: string): Promise<RepositoryBranch[]> {
		return this.boundary(async () => {
			await this.verify(id);
			const output = await this.run(id, [
				"for-each-ref",
				"--count=1001",
				"--format=%(refname:strip=2)%00%(objectname)",
				"refs/heads/",
			]);
			const lines = output.trim().split("\n").filter(Boolean);
			if (lines.length > 1000) throw new WorkspaceError("workspace-unavailable");
			return repositoryBranchesSchema.parse(
				lines.map((line) => {
					const [name, sha] = line.split("\0");
					return { name, sha };
				}),
			);
		});
	}
	async tree(id: string, branch: string, path: string): Promise<RepositoryTree> {
		return this.boundary(async () => {
			if (!treePathSchema.safeParse(path).success) throw new WorkspaceError("invalid-request");
			const head = await this.head(id, branch);
			const entries = (await this.entries(id, head, path)).filter(
				(e) => e.mode === "040000" || e.mode === "100644" || e.mode === "100755",
			);
			const values: RepositoryTree["entries"] = [];
			// Bound both the response and concurrent Git subprocesses.
			for (let index = 0; index < Math.min(entries.length, 1000); index += 8) {
				values.push(
					...(await Promise.all(
						entries.slice(index, Math.min(index + 8, 1000)).map(async (entry) => {
							const relative = path ? `${path}/${entry.name}` : entry.name;
							const lastCommit = (await this.log(id, head, 0, 1, relative)).at(0);
							return {
								name: entry.name,
								path: relative,
								kind: entry.mode === "040000" ? ("directory" as const) : ("file" as const),
								lastCommit,
							};
						}),
					)),
				);
			}
			values.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
			return repositoryTreeSchema.parse({ path, head, entries: values, truncated: entries.length > 1000 });
		});
	}
	async file(id: string, branch: string, path: string): Promise<RepositoryFile> {
		return this.boundary(async () => {
			if (!filePathSchema.safeParse(path).success) throw new WorkspaceError("invalid-request");
			const head = await this.head(id, branch);
			const parts = path.split("/");
			const name = parts.pop();
			const entry = (await this.entries(id, head, parts.join("/"))).find((e) => e.name === name);
			if (!entry) throw new WorkspaceError("file-not-found");
			if (entry.mode !== "100644" && entry.mode !== "100755") throw new WorkspaceError("file-unsupported");
			const size = Number((await this.run(id, ["cat-file", "-s", entry.sha])).trim());
			if (!Number.isSafeInteger(size) || size > 262144) throw new WorkspaceError("file-unsupported");
			let content: string;
			try {
				content = await this.run(id, ["cat-file", "blob", entry.sha]);
			} catch (cause) {
				throw new WorkspaceError("file-unsupported", { cause });
			}
			if (content.includes("\0") || Buffer.byteLength(content) > 262144)
				throw new WorkspaceError("file-unsupported");
			return { path, content };
		});
	}
	async history(id: string, branch: string, offset: number, limit: number): Promise<RepositoryHistory> {
		return this.boundary(async () => {
			if (
				!Number.isSafeInteger(offset)
				|| offset < 0
				|| offset > 100000
				|| !Number.isSafeInteger(limit)
				|| limit < 1
				|| limit > 100
			)
				throw new WorkspaceError("invalid-request");
			const head = await this.head(id, branch);
			const commits = await this.log(id, head, offset, limit + 1);
			return { head, commits: commits.slice(0, limit), hasMore: commits.length > limit };
		});
	}
	private async editTree(
		id: string,
		tree: string | undefined,
		files: { path: string; content: string }[],
	): Promise<string> {
		const entries = new Map<string, { mode: string; type: string; sha: string }>();
		if (tree) {
			const output = await this.run(id, ["ls-tree", "-z", tree]);
			for (const entry of output.split("\0").filter(Boolean)) {
				const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(entry);
				if (!match) throw new Error("Invalid tree");
				entries.set(match.at(4)!, { mode: match.at(1)!, type: match.at(2)!, sha: match.at(3)! });
			}
		}
		const groups = new Map<string, { path: string; content: string }[]>();
		for (const file of files) {
			const name = file.path.split("/").at(0)!;
			groups.set(name, [...(groups.get(name) ?? []), file]);
		}
		for (const [name, values] of groups) {
			const existing = entries.get(name);
			const direct = values.find((file) => file.path === name);
			if (direct) {
				if (values.length !== 1 || (existing && !["100644", "100755"].includes(existing.mode)))
					throw new WorkspaceError("file-unsupported");
				const sha = gitShaSchema.parse(
					(await this.run(id, ["hash-object", "-w", "--stdin"], direct.content)).trim(),
				);
				entries.set(name, { mode: existing?.mode ?? "100644", type: "blob", sha });
			} else {
				if (existing && existing.mode !== "040000") throw new WorkspaceError("file-unsupported");
				const sha = await this.editTree(
					id,
					existing?.sha,
					values.map((file) => ({ ...file, path: file.path.slice(name.length + 1) })),
				);
				entries.set(name, { mode: "040000", type: "tree", sha });
			}
		}
		return gitShaSchema.parse(
			(
				await this.run(
					id,
					["mktree", "-z"],
					[...entries].map(([name, entry]) => `${entry.mode} ${entry.type} ${entry.sha}\t${name}\0`).join(""),
				)
			).trim(),
		);
	}
	private async verify(id: string): Promise<void> {
		if (!projectIdSchema.safeParse(id).success) throw new WorkspaceError("invalid-request");
		await this.repositories.verify(id);
	}
	private async head(id: string, branch: string): Promise<string> {
		if (!branchNameSchema.safeParse(branch).success) throw new WorkspaceError("invalid-request");
		const value = (await this.branches(id)).find((b) => b.name === branch)?.sha;
		if (!value) throw new WorkspaceError("invalid-request");
		return value;
	}
	private run(id: string, args: string[], input?: string): Promise<string> {
		return this.git.run(
			["--literal-pathspecs", "-C", join(this.root, "repositories", `${id}.git`), ...args],
			input,
		);
	}
	private async entries(
		id: string,
		head: string,
		path: string,
	): Promise<{ name: string; mode: string; sha: string }[]> {
		let output: string;
		try {
			output = await this.run(id, ["ls-tree", "-z", path ? `${head}:${path}` : head]);
		} catch (cause) {
			throw new WorkspaceError("file-not-found", { cause });
		}
		return output
			.split("\0")
			.filter(Boolean)
			.map((line) => {
				const match = /^(\d{6}) (?:blob|tree|commit) ([a-f0-9]{40})\t([\s\S]+)$/u.exec(line);
				if (!match) throw new Error("Invalid Git tree");
				return { mode: match.at(1)!, sha: gitShaSchema.parse(match.at(2)), name: match.at(3)! };
			})
			.filter((e) => filePathSchema.safeParse(path ? `${path}/${e.name}` : e.name).success);
	}
	private async log(
		id: string,
		head: string,
		offset: number,
		limit: number,
		path?: string,
	): Promise<RepositoryCommit[]> {
		const output = await this.run(id, [
			"log",
			"--no-show-signature",
			`--skip=${offset}`,
			`--max-count=${limit}`,
			"--format=%H%x00%s%x00%an%x00%cI%x00",
			head,
			"--",
			...(path ? [path] : []),
		]);
		const parts = output.split("\0");
		const commits: RepositoryCommit[] = [];
		for (let i = 0; i + 3 < parts.length; i += 4)
			commits.push(
				repositoryCommitSchema.parse({
					sha: parts.at(i)!.trim(),
					subject: parts.at(i + 1),
					author: parts.at(i + 2),
					date: parts.at(i + 3),
				}),
			);
		return commits;
	}
	private async boundary<T>(action: () => Promise<T>): Promise<T> {
		try {
			return await action();
		} catch (cause) {
			if (cause instanceof WorkspaceError) throw cause;
			throw new WorkspaceError("workspace-unavailable", { cause });
		}
	}
}
