import type { Workspace } from "@forge/contracts";

import type { FileMetadata } from "../repositories/types.ts";

export type WorkspaceRecord = Omit<Workspace, "head">;
export interface WorkspaceLocation {
	workspace: Workspace;
	/** Internal only: never include this path in browser responses. */
	path: string;
}
export interface IWorkspaceFiles {
	mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
	lstat(path: string): Promise<FileMetadata & { size: number; mode: number; mtimeMs: number }>;
	readFile(path: string): Promise<string | undefined>;
	readFileBytes(path: string): Promise<Buffer>;
	createFileIfMissing(path: string, data: string, options?: { mode?: number }): Promise<boolean>;
	atomicWriteFile(path: string, data: string, options?: { mode?: number }): Promise<void>;
	readdir(path: string): Promise<string[]>;
	chmod(path: string, mode: number): Promise<void>;
	realpath(path: string): Promise<string>;
}
