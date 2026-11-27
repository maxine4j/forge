import { isFileError } from "@forge/backend-infrastructure/file";

import type { TerminalIdentity } from "./types.ts";

export interface ITerminalInventoryFiles {
	readdir(path: string): Promise<string[]>;
	readFile(path: string): Promise<string | undefined>;
}
export interface ITerminalInventory {
	/** Captures the leader identity, or returns undefined while session setup is pending. Throws on missing or invalid process data. */
	identify(pid: number): Promise<TerminalIdentity | undefined>;
	/** Only process groups in this session/device; rejects a reused session leader. */
	groups(identity: TerminalIdentity, signal?: AbortSignal): Promise<Set<number>>;
}
export class TerminalInventory implements ITerminalInventory {
	constructor(private readonly files: ITerminalInventoryFiles) {}
	async identify(pid: number): Promise<TerminalIdentity | undefined> {
		const entry = await this.entry(pid);
		if (!entry) throw new Error("Invalid PTY session identity");
		if (entry.sessionId !== pid || entry.tty === 0) return undefined;
		return { sessionId: pid, tty: entry.tty, started: entry.started };
	}
	async groups(identity: TerminalIdentity, signal?: AbortSignal): Promise<Set<number>> {
		const leader = await this.entry(identity.sessionId);
		if (leader && leader.started !== identity.started) return new Set();
		const names = await this.files.readdir("/proc");
		if (names.length > 4096) throw new Error("Process inventory capacity reached");
		const result = new Set<number>();
		for (const name of names) {
			signal?.throwIfAborted();
			if (!/^\d+$/u.test(name)) continue;
			const entry = await this.entry(Number(name));
			// The kernel may clear tty on session-leader exit; the SID remains owned until its last member exits.
			if (entry && entry.group > 1 && entry.sessionId === identity.sessionId && entry.state !== "Z")
				result.add(entry.group);
		}
		return result;
	}
	private async entry(
		pid: number,
	): Promise<{ sessionId: number; tty: number; started: string; group: number; state: string } | undefined> {
		let value: string | undefined;
		try {
			value = await this.files.readFile(`/proc/${pid}/stat`);
		} catch (error) {
			if (isFileError(error, "ENOENT") || isFileError(error, "ESRCH")) return undefined;
			throw error;
		}
		if (value === undefined) return undefined;
		if (value.length > 8192 || !value.startsWith(`${pid} (`)) throw new Error("Invalid process inventory");
		const fields = value
			.slice(value.lastIndexOf(")") + 2)
			.trim()
			.split(/\s+/u);
		const group = Number(fields.at(2));
		const sessionId = Number(fields.at(3));
		const tty = Number(fields.at(4));
		const started = fields.at(19) ?? "";
		if (
			!Number.isSafeInteger(group)
			|| group < 0
			|| !Number.isSafeInteger(sessionId)
			|| sessionId < 0
			|| !Number.isSafeInteger(tty)
			|| !/^\d+$/u.test(started)
		)
			throw new Error("Invalid process inventory");
		return { group, sessionId, tty, started, state: fields.at(0) ?? "" };
	}
}
