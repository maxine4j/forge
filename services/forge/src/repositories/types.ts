import type { GitIdentity } from "@forge/contracts/settings";

export interface FileMetadata {
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}
export interface IRepositoryFiles {
	mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
	lstat(path: string): Promise<FileMetadata>;
	readFile(path: string): Promise<string | undefined>;
	createFileIfMissing(path: string, data: string): Promise<boolean>;
	atomicWriteFile(path: string, data: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
}
export interface GitTransportConfiguration {
	identity?: () => GitIdentity | undefined;
	executable?: string;
	prefix?: string[];
	deadlineMs?: number;
	githubConfigDirectory?: string;
}
export interface UpstreamSyncDrift {
	branch: string;
	ahead: number;
	behind: number;
}
export type UpstreamSyncResult =
	| { outcome: "synced"; head: string; branch: string }
	| { outcome: "conflict" }
	| { outcome: "changed" }
	| { outcome: "push-failed"; head: string; localUpdated: boolean };
