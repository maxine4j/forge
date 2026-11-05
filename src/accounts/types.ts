import type { AccountStatus } from "@forge/contracts";

export type LoginState = AccountStatus["login"];
export type AccountNotification = (method: string, params: unknown) => void;
export interface AccountProcessSpec {
	program: "codex" | "github";
	arguments: string[];
	onOutput: (chunk: string) => void;
	/** Login prompts arrive on stderr; verification stdout remains structured. */
	onStderr?: (chunk: string) => void;
	/** Known CLI outcome codes handled by the provider, without duplicate command warnings. */
	expectedExitCodes?: number[];
	/** Long lived Codex stdout is bounded per frame by its connection. */
	outputLimit?: number;
}
export interface AccountProcessHandle {
	/** Resolves only after child streams close. Rejects on spawn/output failures. */
	done: Promise<number>;
	write(data: string): void;
	/** TERM, bounded grace, KILL entire process group, await stream closure. */
	stop(): Promise<void>;
}
export interface AccountProcessConfiguration {
	dataDirectory: string;
	codexExecutable: string;
	githubExecutable: string;
	path: string;
}
export interface IAccountDiagnostics {
	warn(fields: { err: unknown; exitCode?: number | null }, message: string): void;
	error(fields: { err: unknown }, message: string): void;
}
