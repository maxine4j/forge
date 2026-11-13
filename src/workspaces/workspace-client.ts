import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import { isFileError } from "@forge/backend-infrastructure/file";
import {
	filePathSchema,
	gitShaSchema,
	treePathSchema,
	workspaceSchema,
	type CreateWorkspaceFile,
	type SaveWorkspaceFile,
	type WorkspaceFile,
	type WorkspaceTree,
} from "@forge/contracts";

import type { IGitTransport } from "../repositories/git-transport.ts";
import type { IRepositoryClient } from "../repositories/repository-client.ts";
import { WorkspaceError } from "./errors.ts";
import type { IWorkspaceFiles, WorkspaceRecord } from "./types.ts";

export interface IWorkspaceClient {
	/** Preceded by durable SQLite intent. Idempotent; never resets a branch or deletes data. */
	prepare(record: WorkspaceRecord): Promise<string>;
	verify(record: WorkspaceRecord): Promise<void>;
	/** Removes only a clean owned checkout and the exact branch tip already reachable from main. */
	removeMerged(record: WorkspaceRecord, candidate: string): Promise<void>;
	/** Discards owned ticket work after confirmed agent settlement. */
	removeAbandoned(record: WorkspaceRecord): Promise<void>;
	/** Verified internal runtime path; never a public response field. */
	location(record: WorkspaceRecord): Promise<string>;
	head(record: WorkspaceRecord): Promise<string>;
	tree(record: WorkspaceRecord, path: string): Promise<WorkspaceTree>;
	read(record: WorkspaceRecord, path: string): Promise<WorkspaceFile>;
	createFile(record: WorkspaceRecord, input: CreateWorkspaceFile): Promise<WorkspaceFile>;
	saveFile(record: WorkspaceRecord, input: SaveWorkspaceFile): Promise<WorkspaceFile>;
	stage(record: WorkspaceRecord, paths: string[], unstage: boolean): Promise<void>;
	commit(record: WorkspaceRecord, message: string, expectedHead: string): Promise<string>;
}
export class WorkspaceClient implements IWorkspaceClient {
	constructor(
		private readonly dataDirectory: string,
		private readonly files: IWorkspaceFiles,
		private readonly git: IGitTransport,
		private readonly repositories: IRepositoryClient,
	) {}
	async prepare(record: WorkspaceRecord): Promise<string> {
		return this.boundary(async () => {
			this.validateRecord(record);
			await this.repositories.verify(record.projectId);
			const root = join(this.dataDirectory, "worktrees");
			await this.files.mkdir(root, { recursive: true, mode: 0o700 });
			await this.requireDirectory(root);
			await this.files.chmod(root, 0o700);
			const path = this.path(record);
			const claim = this.claim(record);
			if (!(await this.exists(claim))) {
				if (await this.exists(path)) throw new Error("Unclaimed worktree");
				if (
					(
						await this.git.run([
							"-C",
							this.repository(record),
							"for-each-ref",
							"--format=%(refname)",
							`refs/heads/${record.branch}`,
						])
					).trim()
				)
					throw new Error("Unclaimed workspace branch");
				await this.files.createFileIfMissing(claim, this.identity(record));
			}
			await this.requireClaim(record);
			if (await this.exists(path)) {
				await this.verify(record);
				return this.base(record);
			}
			let main = (
				await this.git.run([
					"-C",
					this.repository(record),
					"for-each-ref",
					"--format=%(objectname)",
					"refs/heads/main",
				])
			).trim();
			if (!main) {
				const branches = await this.git.run([
					"-C",
					this.repository(record),
					"for-each-ref",
					"--format=%(refname)",
					"refs/",
				]);
				if (branches.trim()) throw new Error("Nonempty repository has no main branch");
				const tree = (
					await this.git.run(["-C", this.repository(record), "hash-object", "-w", "-t", "tree", "/dev/null"])
				).trim();
				main = (
					await this.git.run([
						"-C",
						this.repository(record),
						"-c",
						"user.name=Forge",
						"-c",
						"user.email=forge@localhost",
						"commit-tree",
						tree,
						"-m",
						"Initialize project",
					])
				).trim();
				gitShaSchema.parse(main);
				await this.git.run([
					"-C",
					this.repository(record),
					"update-ref",
					"refs/heads/main",
					main,
					"0".repeat(40),
				]);
			}
			gitShaSchema.parse(main);
			await this.files.createFileIfMissing(this.baseMarker(record), main);
			const base = await this.base(record);
			const existing = (
				await this.git.run([
					"-C",
					this.repository(record),
					"for-each-ref",
					"--format=%(refname)",
					`refs/heads/${record.branch}`,
				])
			).trim();
			await this.git.run([
				"-C",
				this.repository(record),
				"worktree",
				"add",
				"--lock",
				"--reason",
				`Forge workspace ${record.id}`,
				...(existing ? [path, record.branch] : ["-b", record.branch, path, base]),
			]);
			await this.files.chmod(path, 0o700);
			await this.verify(record);
			return this.base(record);
		});
	}
	async verify(record: WorkspaceRecord): Promise<void> {
		await this.boundary(async () => {
			this.validateRecord(record);
			await this.repositories.verify(record.projectId);
			await this.requireDirectory(join(this.dataDirectory, "worktrees"));
			await this.requireClaim(record);
			await this.base(record);
			await this.requireDirectory(this.path(record));
			const metadata = await this.files.lstat(join(this.path(record), ".git"));
			if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Not an owned linked worktree");
			const common = (
				await this.git.run(["-C", this.path(record), "rev-parse", "--path-format=absolute", "--git-common-dir"])
			).trim();
			const branch = await this.currentBranch(record);
			if (
				resolve(common) !== (await this.files.realpath(this.repository(record)))
				|| branch !== `refs/heads/${record.branch}`
			)
				throw new Error("Worktree identity changed");
		});
	}
	async location(record: WorkspaceRecord): Promise<string> {
		await this.verify(record);
		return this.path(record);
	}
	async removeMerged(record: WorkspaceRecord, candidate: string): Promise<void> {
		return this.removeOwned(record, candidate);
	}
	async removeAbandoned(record: WorkspaceRecord): Promise<void> {
		return this.removeOwned(record);
	}
	private async removeOwned(record: WorkspaceRecord, candidate?: string): Promise<void> {
		await this.boundary(async () => {
			this.validateRecord(record);
			if (candidate !== undefined) gitShaSchema.parse(candidate);
			await this.repositories.verify(record.projectId);
			const repo = ["-C", this.repository(record)];
			const branch = `refs/heads/${record.branch}`;
			const refs = await this.git.run([...repo, "for-each-ref", "--format=%(refname) %(objectname)", branch]);
			const tip = refs
				.split("\n")
				.find((line) => line.startsWith(`${branch} `))
				?.slice(branch.length + 1);
			const root = dirname(this.path(record));
			if (!(await this.exists(root))) {
				if (candidate || tip) throw new Error("Missing workspace ownership");
				return;
			}
			await this.requireDirectory(root);
			if (
				!candidate
				&& !tip
				&& !(await this.exists(this.claim(record)))
				&& !(await this.exists(this.path(record)))
			)
				return;
			await this.requireClaim(record);
			if (candidate) await this.base(record);
			if (candidate && tip && tip !== candidate) throw new Error("Merged workspace branch changed");
			const main = candidate
				? gitShaSchema.parse((await this.git.run([...repo, "rev-parse", "refs/heads/main"])).trim())
				: undefined;
			if (candidate && main) await this.git.run([...repo, "merge-base", "--is-ancestor", candidate, main]);

			const path = this.path(record);
			const registeredPath = join(await this.files.realpath(dirname(path)), record.id);
			const worktrees = await this.git.run([...repo, "worktree", "list", "--porcelain", "-z"]);
			const entries = worktrees.split("\0\0").map((entry) => entry.split("\0"));
			const entry = entries.find(
				([first]) => first === `worktree ${path}` || first === `worktree ${registeredPath}`,
			);
			if (entries.some((other) => other !== entry && other.includes(`branch ${branch}`)))
				throw new Error("Merged workspace branch is checked out elsewhere");
			const exists = await this.exists(path);
			if (entry) {
				if (
					!tip
					|| (candidate
						? !entry.includes(`branch ${branch}`) || !entry.includes(`HEAD ${candidate}`)
						: !exists && !entry.includes(`branch ${branch}`))
				)
					throw new Error("Merged worktree identity changed");
				if (exists) {
					await this.verify(record);
					if (
						candidate
						&& (await this.git.run(["-C", path, "status", "--porcelain", "--untracked-files=all"])).trim()
					)
						throw new Error("Merged worktree has local changes");
				}
				const locked = entry.some((field) => field === "locked" || field.startsWith("locked "));
				if (locked) await this.git.run([...repo, "worktree", "unlock", path]);
				try {
					await this.git.run([...repo, "worktree", "remove", ...(!candidate ? ["--force"] : []), path]);
				} catch (cause) {
					if (locked)
						await this.git.run([
							...repo,
							"worktree",
							"lock",
							"--reason",
							`Forge workspace ${record.id}`,
							path,
						]);
					throw cause;
				}
			} else if (exists) {
				throw new Error("Merged worktree is unregistered");
			}
			if (tip)
				await this.git.run(
					[...repo, "update-ref", "--stdin"],
					`start\n${main ? `verify refs/heads/main ${main}\n` : ""}delete ${branch} ${tip}\nprepare\ncommit\n`,
				);
		});
	}
	async head(record: WorkspaceRecord): Promise<string> {
		return this.boundary(async () => {
			await this.verify(record);
			return gitShaSchema.parse((await this.git.run(["-C", this.path(record), "rev-parse", "HEAD"])).trim());
		});
	}
	async tree(record: WorkspaceRecord, path: string): Promise<WorkspaceTree> {
		return this.boundary(async () => {
			if (!treePathSchema.safeParse(path).success) throw new WorkspaceError("invalid-request");
			const target = await this.safePath(record, path, false);
			await this.requireDirectory(target);
			const names = (await this.files.readdir(target)).sort();
			const entries: WorkspaceTree["entries"] = [];
			let truncated = false;
			for (const name of names) {
				const relative = path ? `${path}/${name}` : name;
				if (!filePathSchema.safeParse(relative).success) continue;
				const meta = await this.files.lstat(join(target, name));
				if (meta.isSymbolicLink() || (!meta.isFile() && !meta.isDirectory())) continue;
				if (entries.length === 1000) {
					truncated = true;
					break;
				}
				entries.push({
					name,
					path: relative,
					kind: meta.isDirectory() ? "directory" : "file",
					lastChangedAt: new Date(meta.mtimeMs).toISOString(),
				});
			}
			return { path, entries, truncated };
		});
	}
	async read(record: WorkspaceRecord, path: string): Promise<WorkspaceFile> {
		return this.boundary(async () => {
			const target = await this.safePath(record, path, false);
			return this.readText(target, path);
		});
	}
	async createFile(record: WorkspaceRecord, input: CreateWorkspaceFile): Promise<WorkspaceFile> {
		return this.boundary(async () => {
			this.validateContent(input.content);
			const path = await this.safePath(record, input.path, true);
			if (!(await this.files.createFileIfMissing(path, input.content))) throw new WorkspaceError("file-conflict");
			return this.readText(path, input.path);
		});
	}
	async saveFile(record: WorkspaceRecord, input: SaveWorkspaceFile): Promise<WorkspaceFile> {
		return this.boundary(async () => {
			this.validateContent(input.content);
			const path = await this.safePath(record, input.path, false);
			const current = await this.readText(path, input.path);
			if (current.version !== input.version) throw new WorkspaceError("file-conflict");
			const metadata = await this.files.lstat(path);
			await this.files.atomicWriteFile(path, input.content, { mode: metadata.mode & 0o777 });
			return this.readText(path, input.path);
		});
	}
	async stage(record: WorkspaceRecord, paths: string[], unstage: boolean): Promise<void> {
		await this.boundary(async () => {
			for (const path of paths) {
				const target = await this.safePath(record, path, true, true);
				if ((await this.exists(target)) && !(await this.files.lstat(target)).isFile())
					throw new WorkspaceError("file-unsupported");
			}
			await this.git.run([
				"--literal-pathspecs",
				"-C",
				this.path(record),
				...(unstage ? ["restore", "--staged"] : ["add", "--all"]),
				"--",
				...paths,
			]);
		});
	}
	async commit(record: WorkspaceRecord, message: string, expectedHead: string): Promise<string> {
		return this.boundary(async () => {
			if ((await this.head(record)) !== expectedHead) throw new WorkspaceError("workspace-conflict");
			const names = (
				await this.git.run([
					"-C",
					this.path(record),
					"diff",
					"--cached",
					"--name-only",
					"-z",
					"--no-ext-diff",
					"--no-textconv",
					"--",
				])
			)
				.split("\0")
				.filter(Boolean);
			if (!names.length) throw new WorkspaceError("workspace-conflict");
			if (names.some((name) => !filePathSchema.safeParse(name).success))
				throw new WorkspaceError("file-unsupported");
			const tree = (await this.git.run(["-C", this.path(record), "write-tree"])).trim();
			const commit = gitShaSchema.parse(
				(
					await this.git.run([
						"-C",
						this.path(record),
						"-c",
						"user.name=Forge",
						"-c",
						"user.email=forge@localhost",
						"-c",
						"commit.gpgSign=false",
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
				await this.git.run([
					"-C",
					this.path(record),
					"update-ref",
					`refs/heads/${record.branch}`,
					commit,
					expectedHead,
				]);
			} catch (cause) {
				throw new WorkspaceError("workspace-conflict", { cause });
			}
			return this.head(record);
		});
	}
	private async base(record: WorkspaceRecord): Promise<string> {
		const meta = await this.files.lstat(this.baseMarker(record));
		if (!meta.isFile() || meta.isSymbolicLink()) throw new Error("Expected immutable workspace base");
		const base = gitShaSchema.parse(await this.files.readFile(this.baseMarker(record)));
		if (record.baseSha && record.baseSha !== base) throw new Error("Workspace base mismatch");
		return base;
	}
	private path(record: WorkspaceRecord): string {
		return join(this.dataDirectory, "worktrees", record.id);
	}
	private repository(record: WorkspaceRecord): string {
		return join(this.dataDirectory, "repositories", `${record.projectId}.git`);
	}
	private claim(record: WorkspaceRecord): string {
		return join(this.dataDirectory, "worktrees", `.${record.id}.claim`);
	}
	private baseMarker(record: WorkspaceRecord): string {
		return join(this.dataDirectory, "worktrees", `.${record.id}.base`);
	}
	private identity(record: WorkspaceRecord): string {
		return JSON.stringify({ id: record.id, projectId: record.projectId, branch: record.branch });
	}
	private async currentBranch(record: WorkspaceRecord): Promise<string> {
		const branch = (
			await this.git.run(["-C", this.path(record), "rev-parse", "--symbolic-full-name", "HEAD"])
		).trim();
		if (branch !== "HEAD") return branch;
		for (const rebase of ["rebase-merge", "rebase-apply"]) {
			const path = (
				await this.git.run([
					"-C",
					this.path(record),
					"rev-parse",
					"--path-format=absolute",
					"--git-path",
					`${rebase}/head-name`,
				])
			).trim();
			if (!(await this.exists(path))) continue;
			await this.requireDirectory(dirname(path));
			const meta = await this.files.lstat(path);
			if (!meta.isFile() || meta.isSymbolicLink()) throw new Error("Invalid rebase identity");
			return (await this.files.readFile(path))?.trim() ?? "HEAD";
		}
		return branch;
	}
	private validateRecord(record: WorkspaceRecord): void {
		workspaceSchema.parse(record);
		if (record.branch !== `forge/workspace/${record.id}`) throw new Error("Unexpected workspace branch");
	}
	private async requireClaim(record: WorkspaceRecord): Promise<void> {
		const meta = await this.files.lstat(this.claim(record));
		if (
			!meta.isFile()
			|| meta.isSymbolicLink()
			|| (await this.files.readFile(this.claim(record))) !== this.identity(record)
		)
			throw new Error("Workspace ownership mismatch");
	}
	private async exists(path: string): Promise<boolean> {
		try {
			await this.files.lstat(path);
			return true;
		} catch (cause) {
			if (isFileError(cause, "ENOENT")) return false;
			throw cause;
		}
	}
	private async requireDirectory(path: string): Promise<void> {
		const meta = await this.files.lstat(path);
		if (!meta.isDirectory() || meta.isSymbolicLink()) throw new Error("Expected directory");
	}
	private async safePath(
		record: WorkspaceRecord,
		relative: string,
		allowMissing: boolean,
		allowMissingParents = false,
	): Promise<string> {
		if (relative !== "" && !filePathSchema.safeParse(relative).success) throw new WorkspaceError("invalid-request");
		await this.verify(record);
		let path = this.path(record);
		const parts = relative ? relative.split("/") : [];
		for (const [index, part] of parts.entries()) {
			path = join(path, part);
			try {
				const meta = await this.files.lstat(path);
				if (meta.isSymbolicLink()) throw new WorkspaceError("file-unsupported");
				if (index < parts.length - 1 && !meta.isDirectory()) throw new WorkspaceError("file-unsupported");
			} catch (cause) {
				if (isFileError(cause, "ENOENT")) {
					if (allowMissingParents) return join(path, ...parts.slice(index + 1));
					if (allowMissing && index === parts.length - 1) return path;
					throw new WorkspaceError("file-not-found");
				}
				throw cause;
			}
		}
		if (relative && dirname(path) === path) throw new WorkspaceError("invalid-request");
		return path;
	}
	private async readText(path: string, relative: string): Promise<WorkspaceFile> {
		const meta = await this.files.lstat(path);
		if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 262144) throw new WorkspaceError("file-unsupported");
		const bytes = await this.files.readFileBytes(path);
		if (bytes.length > 262144 || bytes.includes(0)) throw new WorkspaceError("file-unsupported");
		let content: string;
		try {
			content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new WorkspaceError("file-unsupported");
		}
		return { path: relative, content, version: createHash("sha256").update(bytes).digest("hex") };
	}
	private validateContent(content: string): void {
		if (Buffer.byteLength(content) > 262144 || content.includes("\0") || !content.isWellFormed())
			throw new WorkspaceError("file-unsupported");
	}
	private async boundary<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (cause) {
			if (cause instanceof WorkspaceError) throw cause;
			throw new WorkspaceError("workspace-unavailable", { cause });
		}
	}
}
