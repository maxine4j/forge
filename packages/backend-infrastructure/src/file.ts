import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

export interface FileWriteOptions {
	mode?: number;
	flag?: string;
}
export type FileWriter = (path: string, data: string | Uint8Array, options?: FileWriteOptions) => Promise<void>;
export const writeFile: FileWriter = async (path, data, options) => {
	await fs.writeFile(path, data, options);
};

export type FileReader = (path: string) => Promise<string | undefined>;
export const readFile: FileReader = async (path: string) => {
	try {
		return await fs.readFile(path, "utf-8");
	} catch (error) {
		if (isFileError(error, "ENOENT")) return undefined;
		throw error;
	}
};

/** Raw adapter failures stay inside clients/stores, which sanitize their public errors. */
export const isFileError = (error: unknown, code: string): boolean =>
	typeof error === "object" && error !== null && "code" in error && error.code === code;

export const readFileBytes = (path: string): Promise<Buffer> => fs.readFile(path);
export const mkdir = async (path: string, options?: { recursive?: boolean; mode?: number }): Promise<void> => {
	await fs.mkdir(path, options);
};
export const { stat, lstat, realpath, rename, rm, mkdtemp, readdir, chmod, symlink } = fs;

/** Replaces a file atomically using an exclusively created, restricted sibling. Parent must exist. */
export const atomicWriteFile: FileWriter = async (path, data, options) => {
	const temporary = `${path}.${randomUUID()}.tmp`;
	const handle = await fs.open(temporary, "wx", options?.mode ?? 0o600);
	try {
		try {
			await handle.writeFile(data);
		} finally {
			await handle.close();
		}
		await fs.rename(temporary, path);
	} finally {
		await fs.rm(temporary, { force: true });
	}
};

/** Existing files are never overwritten; false means another creator already owns the path. */
export const createFileIfMissing = async (
	path: string,
	data: string | Uint8Array,
	options?: { mode?: number },
): Promise<boolean> => {
	try {
		await fs.writeFile(path, data, { flag: "wx", mode: options?.mode ?? 0o600 });
		return true;
	} catch (error) {
		if (isFileError(error, "EEXIST")) return false;
		throw error;
	}
};
