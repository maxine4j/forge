import type { TerminalDimensions, TerminalServerMessage, TerminalSession } from "@forge/contracts/terminal";

export interface TerminalProcessSpec extends TerminalDimensions {
	path: string;
	onOutput: (data: string) => void;
}
export interface TerminalProcessHandle {
	done: Promise<number>;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	/** TERM/KILL ordinary descendants and await owned PTY completion. */
	stop(): Promise<void>;
}
export interface TerminalAttachment {
	session: TerminalSession;
	detach(): void;
}
export interface TerminalListener {
	(message: TerminalServerMessage): void;
}
export interface TerminalIdentity {
	sessionId: number;
	tty: number;
	started: string;
}
