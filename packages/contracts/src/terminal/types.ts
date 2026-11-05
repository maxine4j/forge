export interface TerminalDimensions {
	cols: number;
	rows: number;
}
export interface TerminalSession extends TerminalDimensions {
	id: string;
	workspaceId: string;
	status: "starting" | "running" | "exited" | "closed" | "lost";
	createdAt: string;
	endedAt?: string;
	exitCode?: number;
}
export type TerminalClientMessage = { type: "input"; data: string } | ({ type: "resize" } & TerminalDimensions);
export type TerminalServerMessage =
	| { type: "output"; sequence: number; data: string }
	| { type: "gap"; through: number }
	| { type: "status"; session: TerminalSession };
