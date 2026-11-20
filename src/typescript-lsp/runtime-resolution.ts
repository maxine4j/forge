import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { FileReader } from "@forge/backend-infrastructure/file";
import { z } from "zod";

export interface LspFiles {
	readFile: FileReader;
	realpath(path: string): Promise<string>;
	stat(path: string): Promise<{ size: number; isFile(): boolean }>;
	watch(path: string, changed: (path?: string) => void): () => void;
}
export interface CompilerRuntime {
	key: string;
	installation: string;
	packagePath: string;
	version: string;
	kind: "native" | "tsserver";
	entry: string;
}
export class ToolError extends Error {
	constructor(
		public readonly code: "unavailable" | "invalid_input" | "timeout" | "unsupported" | "changed",
		message: string,
	) {
		super(message);
	}
}
export const inside = (root: string, path: string): boolean => {
	const value = relative(root, path);
	return !isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`);
};

export class RuntimeResolver {
	constructor(
		private readonly root: string,
		private readonly files: LspFiles,
	) {}
	async file(path: string): Promise<string> {
		if (!path || isAbsolute(path) || path.includes("\\") || path.split("/").includes("..") || path.includes("\0"))
			throw new ToolError("invalid_input", "Use a worktree-relative path without traversal.");
		const target = resolve(this.root, path);
		if (!inside(this.root, target)) throw new ToolError("invalid_input", "Path is outside the worktree.");
		let canonical: string;
		try {
			canonical = await this.files.realpath(target);
		} catch {
			throw new ToolError("invalid_input", `File does not exist: ${path}`);
		}
		if (!inside(this.root, canonical)) throw new ToolError("invalid_input", "Source symlink leaves the worktree.");
		const stat = await this.files.stat(canonical);
		if (!/\.[cm]?[jt]sx?$/.test(canonical) || !stat.isFile())
			throw new ToolError("invalid_input", "Choose a TS, TSX, JS or JSX source file.");
		if (stat.size > 1024 * 1024) throw new ToolError("invalid_input", "Source exceeds 1 MiB.");
		return canonical;
	}
	async resolve(file: string): Promise<CompilerRuntime> {
		let packagePath = this.root;
		let foundPackage = false;
		for (let directory = dirname(file); inside(this.root, directory); directory = dirname(directory)) {
			if (!foundPackage && (await this.files.readFile(join(directory, "package.json"))) !== undefined) {
				packagePath = directory;
				foundPackage = true;
			}
			const installation = join(directory, "node_modules/typescript");
			const manifest = await this.files.readFile(join(installation, "package.json"));
			if (manifest !== undefined) {
				try {
					const info = z
						.object({
							version: z.string().min(1).max(128),
							bin: z.object({ tsc: z.string().min(1).max(4096) }).optional(),
						})
						.parse(JSON.parse(manifest));
					const major = Number(info.version.split(".")[0]);
					if (major < 4 || major > 7 || !Number.isInteger(major)) throw new Error("unsupported version");
					const canonical = await this.files.realpath(installation);
					const kind = major === 7 ? "native" : "tsserver";
					const entry = resolve(
						canonical,
						kind === "native" ? (info.bin?.tsc ?? "bin/tsc") : "lib/tsserver.js",
					);
					if (!inside(canonical, entry) || !(await this.files.stat(entry)).isFile())
						throw new Error("missing compiler entrypoint");
					return {
						key: `${canonical}:${info.version}`,
						installation: canonical,
						packagePath,
						version: info.version,
						kind,
						entry,
					};
				} catch {
					throw new ToolError(
						"unavailable",
						`Broken or unsupported TypeScript for ${relative(this.root, packagePath) || "."}. Reinstall a supported TypeScript 4–7 at ${relative(this.root, installation)}; no compiler was substituted.`,
					);
				}
			}
			if (directory === this.root) break;
		}
		throw new ToolError(
			"unavailable",
			`TypeScript is missing for package ${relative(this.root, packagePath) || "."}. Install its declared dependencies (expected ${relative(this.root, packagePath) || "."}/node_modules/typescript).`,
		);
	}
}
