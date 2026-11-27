import {
	commitDetailSchema,
	commitPatchSchema,
	gitShaSchema,
	type CommitDetail,
	type CommitPatch,
} from "@forge/contracts";

import { WorkspaceError } from "../workspaces/errors.ts";

/** Git commands are supplied by the repository client after ownership verification. */
export class CommitReader {
	constructor(
		private readonly run: (args: string[]) => Promise<string>,
		private readonly bytes?: (args: string[]) => Promise<Uint8Array>,
	) {}
	async detail(sha: string): Promise<CommitDetail> {
		if (!gitShaSchema.safeParse(sha).success) throw new WorkspaceError("invalid-request");
		let metadata: string;
		try {
			if ((await this.run(["cat-file", "-t", sha])).trim() !== "commit") throw new Error("Not a commit");
			metadata = await this.run([
				"show",
				"-s",
				"--no-show-signature",
				"--format=%H%x00%s%x00%an%x00%aI%x00%P%x00%B",
				sha,
			]);
		} catch {
			throw new WorkspaceError("file-not-found");
		}
		const [head, subject, author, date, parentText, message] = metadata.split("\0");
		const parents = parentText ? parentText.split(" ") : [];
		const base = parents[0] ?? null;
		const files: CommitDetail["files"] = [];
		let truncated = false;
		try {
			const tokens = (await this.run([...this.args(sha, base), "--numstat", "-z"])).split("\0");
			for (let i = 0; i < tokens.length; i++) {
				const token = tokens[i]!;
				if (!token) continue;
				const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(token);
				if (!match) throw new Error("Invalid numstat");
				let path = match[3]!;
				let oldPath: string | undefined;
				if (!path) {
					oldPath = tokens[++i];
					path = tokens[++i]!;
				}
				if (files.length === 1000) {
					truncated = true;
					break;
				}
				files.push({
					path,
					...(oldPath ? { oldPath } : {}),
					status: oldPath ? "R" : "M",
					additions: Number(match[1]) || 0,
					deletions: Number(match[2]) || 0,
					binary: match[1] === "-",
				});
			}
			const names = (await this.run([...this.args(sha, base), "--raw", "--no-abbrev", "-z"])).split("\0");
			for (let i = 0; i < names.length && names[i];) {
				const raw = /^:(\d{6}) (\d{6}) [a-f0-9]{40} [a-f0-9]{40} ([AMDRT]\d*)$/u.exec(names[i++]!);
				if (!raw) throw new Error("Invalid raw diff");
				const status = raw[3]!;
				const old = names[i++]!;
				const path = status.startsWith("R") ? names[i++]! : old;
				const file = files.find((f) => f.path === path);
				if (file) {
					file.status = status[0] as typeof file.status;
					file.oldMode = raw[1]!;
					file.newMode = raw[2]!;
				}
			}
		} catch {
			truncated = true;
		}
		return commitDetailSchema.parse({
			sha: head,
			subject,
			author,
			date,
			message,
			parents,
			base,
			files,
			additions: files.reduce((n, f) => n + f.additions, 0),
			deletions: files.reduce((n, f) => n + f.deletions, 0),
			truncated,
		});
	}
	async patch(sha: string, path: string, ignoreWhitespace: boolean): Promise<CommitPatch> {
		if (
			!path
			|| path.length > 4096
			|| path.includes("\0")
			|| path.includes("\\")
			|| path.startsWith("/")
			|| path
				.split("/")
				.some((part) => !part || part === ".." || part === "." || part === ".git" || part.startsWith(".forge-"))
		)
			throw new WorkspaceError("invalid-request");
		const detail = await this.detail(sha);
		const file = detail.files.find((f) => f.path === path);
		if (!file) throw new WorkspaceError("file-not-found");
		const result: CommitPatch = {
			path,
			status: file.status,
			binary: file.binary,
			submodule: file.oldMode === "160000" || file.newMode === "160000",
			oldMode: file.oldMode,
			newMode: file.newMode,
			truncated: false,
			additions: 0,
			deletions: 0,
			hunks: [],
		};
		let patch: string;
		try {
			const args = [
				...this.args(sha, detail.base),
				"--patch",
				...(ignoreWhitespace ? ["--ignore-all-space", "--ignore-blank-lines"] : []),
				"--",
				...(file.oldPath ? [file.oldPath] : []),
				path,
			];
			if (this.bytes) {
				const output = await this.bytes(args);
				try {
					patch = new TextDecoder("utf-8", { fatal: true }).decode(output);
				} catch {
					return { ...result, binary: true };
				}
			} else patch = await this.run(args);
		} catch {
			return { ...result, truncated: true };
		}
		let old = 0,
			next = 0,
			count = 0,
			bytes = 0;
		for (const line of patch.split("\n")) {
			bytes += Buffer.byteLength(line) + 1;
			if (++count > 1000 || bytes > 262144) {
				result.truncated = true;
				break;
			}
			const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
			if (header) {
				old = Number(header[1]);
				next = Number(header[2]);
				result.hunks.push({ header: line, lines: [] });
				continue;
			}
			const hunk = result.hunks.at(-1);
			if (!hunk) continue;
			if (line.startsWith("+")) {
				hunk.lines.push({ kind: "addition", text: line.slice(1), new: next++ });
				result.additions++;
			} else if (line.startsWith("-")) {
				hunk.lines.push({ kind: "deletion", text: line.slice(1), old: old++ });
				result.deletions++;
			} else if (line.startsWith(" "))
				hunk.lines.push({ kind: "context", text: line.slice(1), old: old++, new: next++ });
			else if (line.startsWith("\\")) hunk.lines.push({ kind: "marker", text: line });
		}
		return commitPatchSchema.parse(result);
	}
	private args(sha: string, base: string | null): string[] {
		return [
			"--literal-pathspecs",
			"diff-tree",
			"--no-commit-id",
			"-r",
			"--no-color",
			"--no-relative",
			"--no-ext-diff",
			"--no-textconv",
			"--find-renames=50%",
			"-l1000",
			...(base ? [base, sha] : ["--root", sha]),
		];
	}
}
