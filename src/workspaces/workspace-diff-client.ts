import { join } from "node:path";

import { filePathSchema, gitShaSchema, type DiffSection, type WorkspaceDiff } from "@forge/contracts";

import type { IGitDiffClient } from "../repositories/git-diff-client.ts";
import type { IGitBinaryTransport } from "../repositories/git-transport.ts";
import { WorkspaceError } from "./errors.ts";
import type { IWorkspaceFiles, WorkspaceRecord } from "./types.ts";
import type { IWorkspaceClient } from "./workspace-client.ts";

export interface IWorkspaceDiffClient {
	/** Four explicit comparisons. Up to 100 files, 1000 patch lines and 256 KiB per section; truncation is explicit. */
	diff(record: WorkspaceRecord): Promise<WorkspaceDiff>;
}
export class WorkspaceDiffClient implements IWorkspaceDiffClient {
	constructor(
		private readonly workspaces: IWorkspaceClient,
		private readonly git: IGitBinaryTransport,
		private readonly files: IWorkspaceFiles,
		private readonly differences: IGitDiffClient,
	) {}
	async diff(record: WorkspaceRecord): Promise<WorkspaceDiff> {
		try {
			const path = await this.workspaces.location(record);
			const head = await this.workspaces.head(record);
			const baseSha = gitShaSchema.parse(
				(await this.git.run(["-C", path, "merge-base", "refs/heads/main", head])).trim(),
			);
			return {
				comparison: "merge-base(main, workspace)..workspace",
				baseSha,
				head,
				branch: await this.differences.section(path, [baseSha, head]),
				staged: await this.differences.section(path, ["--cached"]),
				unstaged: await this.differences.section(path, []),
				untracked: await this.untracked(path),
			};
		} catch (cause) {
			if (cause instanceof WorkspaceError) throw cause;
			throw new WorkspaceError("workspace-unavailable", { cause });
		}
	}
	private async untracked(path: string): Promise<DiffSection> {
		const section: DiffSection = { files: [], patch: "", truncated: false };
		let names: string[];
		try {
			names = (await this.git.run(["-C", path, "ls-files", "--others", "--exclude-standard", "-z"]))
				.split("\0")
				.filter(Boolean)
				.sort();
		} catch {
			return { ...section, truncated: true };
		}
		for (const name of names) {
			if (!filePathSchema.safeParse(name).success) continue;
			if (section.files.length === 100) {
				section.truncated = true;
				break;
			}
			// Never follow any symlink while producing a preview, including directory components.
			let target = path;
			let binary = false;
			for (const part of name.split("/")) {
				target = join(target, part);
				if ((await this.files.lstat(target)).isSymbolicLink()) {
					binary = true;
					break;
				}
			}
			let content = "";
			if (!binary) {
				const meta = await this.files.lstat(target);
				if (!meta.isFile() || meta.size > 262144) {
					binary = true;
					section.truncated = true;
				} else {
					const bytes = await this.files.readFileBytes(target);
					try {
						if (bytes.includes(0) || bytes.length > 262144) binary = true;
						else content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
					} catch {
						binary = true;
					}
				}
			}
			section.files.push({ path: name, binary });
			if (!binary)
				this.append(
					section,
					`diff --git a/${name} b/${name}\n--- /dev/null\n+++ b/${name}\n${content
						.split("\n")
						.map((line) => `+${line}`)
						.join("\n")}\n`,
				);
		}
		return section;
	}
	private append(section: DiffSection, patch: string): void {
		const remaining = 262144 - Buffer.byteLength(section.patch);
		const lines = Math.max(0, 1000 - section.patch.split("\n").length);
		const selected = patch.split("\n").slice(0, lines).join("\n");
		let bounded = selected;
		if (Buffer.byteLength(bounded) > remaining)
			bounded = new TextDecoder().decode(Buffer.from(bounded).subarray(0, Math.max(0, remaining - 3)));
		if (bounded !== patch) section.truncated = true;
		section.patch += bounded;
	}
}
