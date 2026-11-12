import { isFileError } from "@forge/backend-infrastructure/file";
import type { ISleep } from "@forge/backend-infrastructure/sleep";

import { DOCKER_HOST } from "../docker/docker-command.ts";
import { TerminalError } from "./errors.ts";
import type { ITerminalInventory } from "./terminal-inventory.ts";
import type { TerminalIdentity, TerminalProcessHandle, TerminalProcessSpec } from "./types.ts";

export interface ITerminalProcess {
	/** Starts a Linux PTY at a caller-verified path with curated environment. Throws TerminalError. */
	spawn(spec: TerminalProcessSpec): Promise<TerminalProcessHandle>;
}
export class TerminalProcess implements ITerminalProcess {
	constructor(
		private readonly path: string,
		private readonly sleep: ISleep,
		private readonly inventory: ITerminalInventory,
		private readonly platform: string,
	) {}
	async spawn(spec: TerminalProcessSpec): Promise<TerminalProcessHandle> {
		if (this.platform !== "linux") throw new TerminalError("terminal-unavailable");
		try {
			const pty = await import("node-pty");
			const child = pty.spawn("/bin/bash", ["--noprofile", "--norc", "-i"], {
				cwd: spec.path,
				cols: spec.cols,
				rows: spec.rows,
				name: "xterm-256color",
				env: {
					DOCKER_HOST,
					PATH: this.path,
					HOME: spec.path,
					LANG: "C.UTF-8",
					TERM: "xterm-256color",
					HISTFILE: "/dev/null",
					ENV: "/dev/null",
				},
			});
			let exited = false;
			let stopping: Promise<void> | undefined;
			let resolveExit!: (code: number) => void;
			const exit = new Promise<number>((resolve) => {
				resolveExit = resolve;
			});
			const data = child.onData(spec.onOutput);
			child.onExit(({ exitCode }) => {
				exited = true;
				data.dispose();
				resolveExit(exitCode);
			});
			let identity: TerminalIdentity;
			try {
				identity = await this.startupIdentity(child.pid, exit);
			} catch (cause) {
				if (!exited) this.signal(child.pid, "SIGKILL");
				await this.bounded(exit);
				throw cause;
			}
			const cleanup = async (natural: boolean): Promise<void> => {
				const groups = new Set<number>();
				if (!exited) groups.add(child.pid);
				let failure: unknown;
				try {
					for (const group of await this.groups(identity)) groups.add(group);
				} catch (error) {
					failure = error;
				}
				try {
					for (const group of groups) this.signal(-group, natural ? "SIGKILL" : "SIGTERM");
					if (!natural) await this.delayOrExit(exit);
				} finally {
					try {
						for (const group of await this.groups(identity)) groups.add(group);
					} catch (error) {
						failure ??= error;
					}
					for (const group of groups) this.signal(-group, "SIGKILL");
					await this.bounded(exit);
				}
				if (failure) throw new TerminalError("terminal-unavailable", { cause: failure });
			};
			const done = exit.then(async (code) => {
				stopping ??= cleanup(true);
				await stopping;
				return code;
			});
			void done.catch(() => {});
			return {
				done,
				write: (value) => {
					if (exited || stopping) throw new TerminalError("terminal-unavailable");
					child.write(value);
				},
				resize: (cols, rows) => {
					if (exited || stopping) throw new TerminalError("terminal-unavailable");
					child.resize(cols, rows);
				},
				stop: () => {
					stopping ??= cleanup(false);
					return stopping;
				},
			};
		} catch (cause) {
			throw new TerminalError("terminal-unavailable", { cause });
		}
	}
	private async startupIdentity(pid: number, exit: Promise<number>): Promise<TerminalIdentity> {
		const timer = new AbortController();
		try {
			const identity = await Promise.race([
				this.pollIdentity(pid, timer.signal),
				this.sleep(1000, timer.signal),
				exit.then(() => undefined),
			]);
			if (!identity) throw new Error("PTY exited or timed out during session setup");
			return identity;
		} finally {
			timer.abort();
		}
	}
	private async pollIdentity(pid: number, signal: AbortSignal): Promise<TerminalIdentity> {
		for (;;) {
			signal.throwIfAborted();
			const identity = await this.inventory.identify(pid);
			if (identity) return identity;
			await this.sleep(10, signal);
		}
	}
	private async groups(identity: TerminalIdentity): Promise<Set<number>> {
		const timer = new AbortController();
		try {
			return await Promise.race([
				this.inventory.groups(identity, timer.signal),
				this.sleep(1000, timer.signal).then(() => {
					throw new TerminalError("terminal-unavailable");
				}),
			]);
		} finally {
			timer.abort();
		}
	}
	private signal(pid: number, signal: NodeJS.Signals): void {
		try {
			process.kill(pid, signal);
		} catch (cause) {
			if (!isFileError(cause, "ESRCH")) throw new TerminalError("terminal-unavailable", { cause });
		}
	}
	private async delayOrExit(exit: Promise<number>): Promise<void> {
		const timer = new AbortController();
		try {
			await Promise.race([exit, this.sleep(1000, timer.signal)]);
		} finally {
			timer.abort();
		}
	}
	private async bounded(exit: Promise<number>): Promise<void> {
		const timer = new AbortController();
		try {
			await Promise.race([
				exit,
				this.sleep(1000, timer.signal).then(() => {
					throw new TerminalError("terminal-unavailable");
				}),
			]);
		} finally {
			timer.abort();
		}
	}
}
