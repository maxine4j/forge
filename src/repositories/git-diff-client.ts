import { filePathSchema, type DiffSection } from "@forge/contracts";

import type { IGitBinaryTransport } from "./git-transport.ts";

export interface IGitDiffClient {
	/** Read-only patch for trusted caller-supplied revisions; 100 files, 1000 lines, 256 KiB.
	 * Invalid paths, output bounds and unavailable patches set truncated; never return raw Git diagnostics. */
	section(path: string, revisions: string[]): Promise<DiffSection>;
}
export class GitDiffClient implements IGitDiffClient {
	constructor(private readonly git: IGitBinaryTransport) {}
	async section(path: string, revisions: string[]): Promise<DiffSection> {
		const result: DiffSection = { files: [], patch: "", truncated: false };
		const prefix = ["--literal-pathspecs", "-C", path, "diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
		let names: string[];
		try {
			names = (await this.git.run([...prefix, "--name-only", "-z", ...revisions, "--"]))
				.split("\0")
				.filter(Boolean);
		} catch {
			return { ...result, truncated: true };
		}
		for (const name of names) {
			if (!filePathSchema.safeParse(name).success || result.files.length >= 100) {
				result.truncated = true;
				continue;
			}
			const file = { path: name, binary: false };
			result.files.push(file);
			try {
				file.binary = (await this.git.run([...prefix, "--numstat", ...revisions, "--", name])).startsWith(
					"-\t-\t",
				);
				if (file.binary) continue;
				const bytes = await this.git.runBytes([...prefix, "--unified=3", ...revisions, "--", name]);
				let patch: string;
				try {
					patch = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
				} catch {
					file.binary = true;
					continue;
				}
				const lines = Math.max(0, 1000 - result.patch.split("\n").length);
				const bounded = patch.split("\n").slice(0, lines).join("\n");
				if (Buffer.byteLength(result.patch + bounded) > 262144) {
					result.truncated = true;
					continue;
				}
				result.patch += bounded;
				if (bounded !== patch) result.truncated = true;
			} catch {
				result.truncated = true;
			}
		}
		return result;
	}
}
