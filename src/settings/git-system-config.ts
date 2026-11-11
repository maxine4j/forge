import { dirname, join } from "node:path";

import type { GitIdentity } from "@forge/contracts/settings";

interface IGitSystemConfigFiles {
	mkdtemp(prefix: string): Promise<string>;
	writeFile(path: string, data: string, options: { mode: number; flag: string }): Promise<void>;
	chmod(path: string, mode: number): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

export interface IGitSystemConfig {
	/** Atomically replaces the included file. A failed write leaves the previous identity in effect. */
	publish(identity: GitIdentity | undefined): Promise<void>;
}

export class GitSystemConfig implements IGitSystemConfig {
	constructor(
		private readonly path: string,
		private readonly files: IGitSystemConfigFiles,
	) {}

	async publish(identity: GitIdentity | undefined): Promise<void> {
		const directory = await this.files.mkdtemp(join(dirname(this.path), ".identity-"));
		const temporary = join(directory, "gitconfig");
		try {
			const data = identity
				? `[user]\n\tname = ${this.quote(identity.name)}\n\temail = ${this.quote(identity.email)}\n`
				: "";
			await this.files.writeFile(temporary, data, { mode: 0o600, flag: "wx" });
			await this.files.chmod(temporary, 0o644);
			await this.files.rename(temporary, this.path);
		} finally {
			// Cleanup failure must not report a failed publication after a successful rename.
			await this.files.rm(directory, { recursive: true, force: true }).catch(() => {});
		}
	}

	private quote(value: string): string {
		return `"${value.replace(/[\\"]/gu, "\\$&")}"`;
	}
}
