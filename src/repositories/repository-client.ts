import { join } from "node:path";

import { isFileError } from "@forge/backend-infrastructure/file";
import { projectIdSchema, remoteSourceSchema } from "@forge/contracts";

import type { IGitTransport } from "./git-transport.ts";
import type { IRepositoryFiles } from "./types.ts";

export class RepositoryError extends Error {
	constructor(options?: ErrorOptions) {
		super("Repository unavailable", options);
		this.name = "RepositoryError";
	}
}
export interface IRepositoryClient {
	/** Idempotent create/import for persisted UUID intent. Never deletes data. Throws RepositoryError. */
	prepare(id: string, source?: string): Promise<void>;
	/** Requires an owned bare repository, not merely an existing path. */
	verify(id: string): Promise<void>;
	/** Git configuration is authoritative; presence does not imply a readable/allowed URL. */
	hasUpstream(id: string): Promise<boolean>;
	/** Returns the configured URL after applying import URL restrictions. */
	upstreamUrl(id: string): Promise<string>;
	/** Adds only a missing upstream; preserves all existing configuration and refs. */
	configureUpstream(id: string, source: string): Promise<void>;
}
export class RepositoryClient implements IRepositoryClient {
	constructor(
		private readonly dataDirectory: string,
		private readonly importHosts: string[],
		private readonly files: IRepositoryFiles,
		private readonly git: IGitTransport,
	) {}
	async prepare(id: string, source?: string): Promise<void> {
		try {
			projectIdSchema.parse(id);
			if (source !== undefined) this.validateSource(source);
			const root = join(this.dataDirectory, "repositories");
			await this.files.mkdir(root, { recursive: true, mode: 0o700 });
			await this.requireDirectory(root);
			const target = join(root, `${id}.git`);
			if (await this.exists(target)) {
				await this.verify(id);
				if (source !== undefined) await this.configureUpstream(id, source);
				return;
			}
			const staging = join(root, `.${id}.pending`);
			const claim = join(root, `.${id}.claim`);
			if (!(await this.exists(claim))) {
				if (await this.exists(staging)) throw new Error("Unclaimed staging directory");
				// An empty exclusive claim has no partially written identity bytes to recover.
				await this.files.createFileIfMissing(claim, "");
			}
			await this.requireMarker(claim, "");
			if (!(await this.exists(staging))) await this.files.mkdir(staging, { mode: 0o700 });
			await this.requireDirectory(staging);
			const repository = join(staging, "repository.git");
			if (await this.exists(repository)) await this.requireDirectory(repository);
			// Git init safely completes an interrupted init and preserves existing objects/refs.
			await this.git.run(["init", "--bare", "--initial-branch=main", repository]);
			await this.requireBare(repository);
			if (source !== undefined) {
				await this.addUpstream(repository, source);
				// Fetching explicit heads/tags is idempotent after a crash; never runs checkout hooks or submodules.
				await this.git.run([
					"-C",
					repository,
					"fetch",
					"--no-recurse-submodules",
					"--no-write-fetch-head",
					source,
					"+refs/heads/*:refs/heads/*",
					"+refs/tags/*:refs/tags/*",
				]);
				const refs = await this.git.run(["ls-remote", "--symref", source, "HEAD"]);
				const head = /^ref: (refs\/heads\/[^\s]+)\tHEAD$/m.exec(refs)?.at(1);
				if (head) await this.git.run(["-C", repository, "symbolic-ref", "HEAD", head]);
			}
			const owner = join(repository, "forge-owner");
			if (!(await this.exists(owner))) await this.files.atomicWriteFile(owner, id);
			await this.requireOwner(repository, id);
			if (await this.exists(target)) throw new Error("Repository publication conflict");
			await this.files.rename(repository, target);
			await this.verify(id);
		} catch (cause) {
			throw new RepositoryError({ cause });
		}
	}
	async verify(id: string): Promise<void> {
		try {
			projectIdSchema.parse(id);
			const root = join(this.dataDirectory, "repositories");
			await this.requireDirectory(root);
			const repository = join(root, `${id}.git`);
			await this.requireOwner(repository, id);
			await this.requireBare(repository);
		} catch (cause) {
			throw new RepositoryError({ cause });
		}
	}
	async hasUpstream(id: string): Promise<boolean> {
		await this.verify(id);
		return this.remotePresent(join(this.dataDirectory, "repositories", `${id}.git`));
	}
	async upstreamUrl(id: string): Promise<string> {
		await this.verify(id);
		const url = (
			await this.git.run([
				"-C",
				join(this.dataDirectory, "repositories", `${id}.git`),
				"config",
				"--local",
				"--get",
				"remote.upstream.url",
			])
		).trim();
		this.validateSource(url);
		return url;
	}
	async configureUpstream(id: string, source: string): Promise<void> {
		await this.verify(id);
		await this.addUpstream(join(this.dataDirectory, "repositories", `${id}.git`), source);
	}
	private async remotePresent(directory: string): Promise<boolean> {
		const remotes = await this.git.run(["-C", directory, "remote"]);
		return remotes.split(/\r?\n/u).includes("upstream");
	}
	private async addUpstream(directory: string, source: string): Promise<void> {
		if (await this.remotePresent(directory)) return;
		this.validateSource(source);
		// One config write is atomic and retryable, with no fetch/ref changes.
		await this.git.run(["-C", directory, "config", "--local", "remote.upstream.url", source]);
	}
	private validateSource(source: string): void {
		remoteSourceSchema.parse(source);
		const url = new URL(source);
		if (!this.importHosts.includes(url.hostname) || (url.port && url.port !== "443"))
			throw new Error("Import host not allowed");
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
		const metadata = await this.files.lstat(path);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Expected owned directory");
	}
	private async requireOwner(path: string, id: string): Promise<void> {
		await this.requireDirectory(path);
		await this.requireMarker(join(path, "forge-owner"), id);
	}
	private async requireMarker(marker: string, id: string): Promise<void> {
		const metadata = await this.files.lstat(marker);
		if (!metadata.isFile() || metadata.isSymbolicLink() || (await this.files.readFile(marker)) !== id)
			throw new Error("Repository ownership mismatch");
	}
	private async requireBare(path: string): Promise<void> {
		await this.requireDirectory(path);
		if ((await this.git.run(["-C", path, "rev-parse", "--is-bare-repository"])).trim() !== "true")
			throw new Error("Expected bare repository");
	}
}
