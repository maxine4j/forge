import { extname, join } from "node:path";

import { isFileError } from "@forge/backend-infrastructure/file";

export interface IAssetFiles {
	lstat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
	readFileBytes(path: string): Promise<Buffer>;
}
export interface IStaticAssets {
	/** Built public files only; undefined for API paths, traversal, symlinks and absent assets. */
	read(path: string): Promise<{ bytes: Buffer; type: string; immutable: boolean } | undefined>;
}
export class StaticAssets implements IStaticAssets {
	constructor(
		private readonly directory: string,
		private readonly files: IAssetFiles,
	) {}
	async read(path: string): Promise<{ bytes: Buffer; type: string; immutable: boolean } | undefined> {
		const types: Record<string, string> = {
			".html": "text/html",
			".js": "text/javascript",
			".css": "text/css",
			".svg": "image/svg+xml",
			".png": "image/png",
			".ico": "image/x-icon",
			".woff2": "font/woff2",
		};
		if (
			!path.startsWith("/")
			|| /[%\\]/u.test(path)
			|| path.includes("\u0000")
			|| path.split("/").some((part) => part === "." || part === "..")
			|| path === "/api"
			|| path.startsWith("/api/")
		)
			return undefined;
		const asset = path.startsWith("/assets/");
		const relative = asset
			? path.slice(1)
			: path === "/favicon.ico"
				? "favicon.ico"
				: extname(path)
					? undefined
					: "index.html";
		if (!relative) return undefined;
		const type = types[extname(relative)];
		if (!type) return undefined;
		try {
			const parts = relative.split("/");
			for (let index = 1; index <= parts.length; index++) {
				const stat = await this.files.lstat(join(this.directory, ...parts.slice(0, index)));
				if (index === parts.length ? !stat.isFile() : !stat.isDirectory()) return undefined;
			}
			return {
				bytes: await this.files.readFileBytes(join(this.directory, relative)),
				type,
				immutable: asset && /-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/u.test(relative),
			};
		} catch (error) {
			if (isFileError(error, "ENOENT") || isFileError(error, "ENOTDIR")) return undefined;
			throw new Error("Frontend assets unavailable", { cause: error });
		}
	}
}
