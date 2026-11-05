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
	executable?: string;
	prefix?: string[];
	deadlineMs?: number;
}
