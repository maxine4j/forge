import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { isFileError, type FileReader } from "@forge/backend-infrastructure/file";
import type { ISleep } from "@forge/backend-infrastructure/sleep";

import type { CompilerRuntime } from "./runtime-resolution.ts";

export interface LanguageProcess {
	pid?: number;
	input: Writable;
	output: Readable;
	done: Promise<void>;
	stop(): Promise<void>;
}
export interface ILanguageProcesses {
	spawn(runtime: CompilerRuntime, root: string): LanguageProcess;
}

/** No detached group: the bridge and every compiler remain in Codex's owned group. */
export class LanguageProcesses implements ILanguageProcesses {
	constructor(
		private readonly node: string,
		private readonly legacyServer: string,
		private readonly read: FileReader,
		private readonly sleep: ISleep,
		private readonly list: (path: string) => Promise<string[]>,
	) {}
	spawn(runtime: CompilerRuntime, root: string): LanguageProcess {
		// An inherited marker also identifies children reparented after a server crash.
		// It is an ownership identity, never a credential, and is not returned by tools.
		const owner = randomUUID();
		const child = spawn(
			this.node,
			runtime.kind === "native" ? [runtime.entry, "--lsp", "--stdio"] : [this.legacyServer, "--stdio"],
			{
				cwd: root,
				detached: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, FORGE_TYPESCRIPT_PROCESS_OWNER: owner },
			},
		);
		child.stderr.resume();
		child.stdin.on("error", () => {});
		let exited = false;
		const done = new Promise<void>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", () => {
				exited = true;
			});
			child.once("close", () => {
				exited = true;
				resolve();
			});
		});
		void done.catch(() => {});
		let stopping: Promise<void> | undefined;
		return {
			pid: child.pid,
			input: child.stdin,
			output: child.stdout,
			done,
			stop: () =>
				(stopping ??= (async () => {
					// Linux /proc keeps descendant cleanup scoped to this server, without signaling unrelated threads.
					const descendants = async (pid: number): Promise<number[]> => {
						const text = await this.read(`/proc/${pid}/task/${pid}/children`);
						const children = (text?.trim().split(/\s+/) ?? []).map(Number).filter((id) => id > 0);
						return [...(await Promise.all(children.map(descendants))).flat(), ...children];
					};
					const owned = await Promise.all(
						(await this.list("/proc"))
							.filter((pid) => /^\d+$/.test(pid))
							.map(async (pid) => {
								try {
									const environment = await this.read(`/proc/${pid}/environ`);
									return environment?.split("\0").includes(`FORGE_TYPESCRIPT_PROCESS_OWNER=${owner}`)
										? Number(pid)
										: 0;
								} catch {
									return 0;
								}
							}),
					);
					const pids = [
						...new Set([...(child.pid ? await descendants(child.pid).catch(() => []) : []), ...owned]),
					].filter((pid) => pid > 0 && pid !== child.pid);
					const kill = (pid: number, signal: NodeJS.Signals) => {
						try {
							process.kill(pid, signal);
						} catch (error) {
							if (!(typeof error === "object" && error && "code" in error && error.code === "ESRCH"))
								throw error;
						}
					};
					for (const pid of pids) kill(pid, "SIGTERM");
					if (!exited) child.kill("SIGTERM");
					const timer = new AbortController();
					await Promise.race([done.catch(() => {}), this.sleep(1000, timer.signal).catch(() => {})]);
					timer.abort();
					for (const pid of pids) kill(pid, "SIGKILL");
					if (!exited) child.kill("SIGKILL");
					await done.catch(() => {});
					for (let attempt = 0; attempt < 100; attempt++) {
						const live = await Promise.all(
							pids.map(async (pid) => {
								try {
									const stat = await this.read(`/proc/${pid}/stat`);
									return stat && !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
								} catch (error) {
									if (isFileError(error, "ESRCH") || isFileError(error, "ENOENT")) return false;
									throw error;
								}
							}),
						);
						if (!live.some(Boolean)) return;
						await this.sleep(10);
					}
					throw new Error("Language-server descendants did not stop");
				})()),
		};
	}
}
