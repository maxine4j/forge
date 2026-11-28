import { join } from "node:path";

import {
	filePathSchema,
	gitShaSchema,
	type DiffSection,
	type WorkspaceChangeSummary,
	type WorkspaceDiff,
} from "@forge/contracts";

import type { IGitDiffClient } from "../repositories/git-diff-client.ts";
import type { IGitBinaryTransport } from "../repositories/git-transport.ts";
import { WorkspaceError } from "./errors.ts";
import type { IWorkspaceFiles, WorkspaceRecord } from "./types.ts";
import type { IWorkspaceClient } from "./workspace-client.ts";

export interface IWorkspaceDiffClient {
	/** Four explicit comparisons. Up to 100 files, 1000 patch lines and 256 KiB per section; truncation is explicit. */
	diff(record: WorkspaceRecord): Promise<WorkspaceDiff>;
	/** Net tracked changes since the merge base with main, plus non-ignored untracked files. */
	changeSummary(record: WorkspaceRecord): Promise<WorkspaceChangeSummary>;
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
			const baseSha = await this.mergeBase(path, head);
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
	async changeSummary(record: WorkspaceRecord): Promise<WorkspaceChangeSummary> {
		try {
			const path = await this.workspaces.location(record);
			const base = await this.mergeBase(path, await this.workspaces.head(record));
			const entries = (
				await this.git.run([
					"-C",
					path,
					"diff",
					"--numstat",
					"-z",
					"--find-renames",
					"--no-ext-diff",
					"--no-textconv",
					base,
					"--",
				])
			).split("\0");
			const names = new Set<string>();
			let additions = 0;
			let deletions = 0;
			let truncated = false;
			for (let index = 0; index < entries.length - 1; index++) {
				const entry = entries[index]!;
				const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(entry);
				if (!match) throw new Error("Invalid Git line statistics");
				// A rename has an empty path field followed by its old and new NUL-delimited paths.
				const name = match[3] || entries[(index += 2)];
				if (!name || !filePathSchema.safeParse(name).success) {
					truncated = true;
					continue;
				}
				names.add(name);
				additions += Number(match[1]) || 0;
				deletions += Number(match[2]) || 0;
			}
			let inspected = 0;
			for (const name of await this.untrackedNames(path)) {
				if (!filePathSchema.safeParse(name).success) {
					truncated = true;
					continue;
				}
				names.add(name);
				if (inspected++ >= 100) {
					truncated = true;
					continue;
				}
				const file = await this.untrackedFile(path, name);
				truncated ||= file.truncated;
				if (file.content) additions += file.content.split("\n").length - Number(file.content.endsWith("\n"));
			}
			return {
				files: [...names].sort().slice(0, 100),
				fileCount: names.size,
				additions,
				deletions,
				truncated: truncated || names.size > 100,
			};
		} catch (cause) {
			if (cause instanceof WorkspaceError) throw cause;
			throw new WorkspaceError("workspace-unavailable", { cause });
		}
	}
	private async mergeBase(path: string, head: string): Promise<string> {
		return gitShaSchema.parse((await this.git.run(["-C", path, "merge-base", "refs/heads/main", head])).trim());
	}
	private async untrackedNames(path: string): Promise<string[]> {
		return (await this.git.run(["-C", path, "ls-files", "--others", "--exclude-standard", "-z"]))
			.split("\0")
			.filter(Boolean)
			.sort();
	}
	private async untracked(path: string): Promise<DiffSection> {
		const section: DiffSection = { files: [], patch: "", truncated: false };
		let names: string[];
		try {
			names = await this.untrackedNames(path);
		} catch {
			return { ...section, truncated: true };
		}
		for (const name of names) {
			if (!filePathSchema.safeParse(name).success) continue;
			if (section.files.length === 100) {
				section.truncated = true;
				break;
			}
			const file = await this.untrackedFile(path, name);
			section.truncated ||= file.truncated;
			section.files.push({ path: name, binary: file.content === undefined });
			if (file.content !== undefined)
				this.append(
					section,
					`diff --git a/${name} b/${name}\n--- /dev/null\n+++ b/${name}\n${file.content
						.split("\n")
						.map((line) => `+${line}`)
						.join("\n")}\n`,
				);
		}
		return section;
	}
	private async untrackedFile(path: string, name: string): Promise<{ content?: string; truncated: boolean }> {
		// Never follow any symlink while producing a preview, including directory components.
		let target = path;
		for (const part of name.split("/")) {
			target = join(target, part);
			if ((await this.files.lstat(target)).isSymbolicLink()) return { truncated: false };
		}
		const meta = await this.files.lstat(target);
		if (!meta.isFile() || meta.size > 262144) return { truncated: true };
		const bytes = await this.files.readFileBytes(target);
		if (bytes.length > 262144) return { truncated: true };
		if (!bytes.includes(0)) {
			try {
				return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), truncated: false };
			} catch {
				return { truncated: false };
			}
		}
		return { truncated: false };
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
