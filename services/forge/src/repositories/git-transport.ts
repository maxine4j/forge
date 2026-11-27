import { spawn } from "node:child_process";

import { isFileError } from "@forge/backend-infrastructure/file";
import { createLogger } from "@forge/backend-infrastructure/logger";
import { sleep, type ISleep } from "@forge/backend-infrastructure/sleep";

import type { GitTransportConfiguration } from "./types.ts";

export class GitError extends Error {
	constructor(
		options?: ErrorOptions,
		readonly exitCode?: number,
	) {
		super("Git operation failed", options);
		this.name = "GitError";
	}
}
export interface IGitTransport {
	/** Noninteractive system Git, 120s deadline, optional UTF-8 stdin, 1 MiB input/output bounds; throws GitError. */
	run(arguments_: string[], input?: string): Promise<string>;
}
export interface IGitBinaryTransport extends IGitTransport {
	/** Same process/time/output bounds; preserves bytes for binary-aware callers. */
	runBytes(arguments_: string[], input?: string): Promise<Buffer>;
}
export interface IGitRuntime extends IGitBinaryTransport {
	close(): Promise<void>;
}
export class GitTransport implements IGitRuntime {
	private readonly log = createLogger(GitTransport.name);
	private readonly active = new Set<() => Promise<void>>();
	private closing: Promise<void> | undefined;
	constructor(
		private readonly pause: ISleep = sleep,
		private readonly config: GitTransportConfiguration = {},
	) {}
	async run(arguments_: string[], input?: string): Promise<string> {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(await this.runBytes(arguments_, input));
		} catch (cause) {
			if (cause instanceof GitError) throw cause;
			throw new GitError({ cause });
		}
	}
	async runBytes(arguments_: string[], input?: string): Promise<Buffer> {
		if (this.closing) throw new GitError();
		if (input !== undefined && Buffer.byteLength(input) > 1048576) throw new GitError();
		let child;
		try {
			const identity = this.config.identity?.();
			child = spawn(
				this.config.executable ?? "git",
				[
					...(this.config.prefix ?? []),
					"-c",
					"protocol.allow=never",
					"-c",
					"protocol.https.allow=always",
					"-c",
					"credential.helper=",
					...(this.config.githubConfigDirectory
						? ["-c", "credential.https://github.com.helper=!gh auth git-credential"]
						: []),
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"http.followRedirects=false",
					...arguments_,
				],
				{
					detached: true,
					stdio: ["pipe", "pipe", "pipe"],
					env: {
						PATH: process.env["PATH"],
						LANG: "C",
						LC_ALL: "C",
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_TERMINAL_PROMPT: "0",
						GIT_ASKPASS: "/bin/false",
						...(identity && {
							GIT_AUTHOR_NAME: identity.name,
							GIT_AUTHOR_EMAIL: identity.email,
							GIT_COMMITTER_NAME: identity.name,
							GIT_COMMITTER_EMAIL: identity.email,
						}),
						...(this.config.githubConfigDirectory
							? { GH_CONFIG_DIR: this.config.githubConfigDirectory }
							: {}),
					},
				},
			);
		} catch (cause) {
			throw new GitError({ cause });
		}
		let failure: unknown;
		let exitCode: number | undefined;
		child.stdin.on("error", (error) => {
			failure = error;
		});
		child.stdin.end(input);
		const stdout: Buffer[] = [];
		let stderr = "";
		let bytes = 0;
		let exited = false;
		const deadline = new AbortController();
		const signalGroup = (signal: NodeJS.Signals): boolean => {
			if (!child.pid) return false;
			try {
				process.kill(-child.pid, signal);
				return true;
			} catch (err) {
				if (!isFileError(err, "ESRCH")) this.log.error({ err }, "Git process group signal failed");
				return false;
			}
		};
		const done = new Promise<void>((resolve) => {
			child.on("error", (error) => {
				failure = error;
			});
			for (const [stream, output] of [
				[child.stdout, true],
				[child.stderr, false],
			] as const) {
				stream.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > 1024 * 1024) {
						failure = new Error("Git output exceeded bound");
						signalGroup("SIGKILL");
						return;
					}
					if (output) stdout.push(chunk);
					else stderr += chunk.toString("utf8");
				});
			}
			child.on("exit", () => {
				exited = true;
				signalGroup("SIGKILL");
			});
			child.on("close", (code, signal) => {
				exited = true;
				deadline.abort();
				if (code !== null && !failure) exitCode = code;
				if (code !== 0 || failure)
					failure = new AggregateError(
						[
							failure,
							new Error(`Git exit code ${code}; signal ${signal}`),
							new Error(stderr),
							new Error(Buffer.concat(stdout).toString("utf8")),
						],
						"Git command failed",
					);
				resolve();
			});
		});
		let stopping: Promise<void> | undefined;
		const stop = (): Promise<void> => {
			stopping ??= (async () => {
				failure ??= new Error("Git operation cancelled");
				if (!exited && signalGroup("SIGTERM")) {
					const grace = new AbortController();
					await Promise.race([done, this.pause(1000, grace.signal).catch(() => {})]);
					grace.abort();
					signalGroup("SIGKILL");
				}
				await done;
			})();
			return stopping;
		};
		this.active.add(stop);
		void this.pause(this.config.deadlineMs ?? 120_000, deadline.signal).then(
			() => {
				failure = new Error("Git command deadline exceeded");
				signalGroup("SIGKILL");
			},
			() => {},
		);
		try {
			await done;
			if (failure) throw new GitError({ cause: failure }, exitCode);
			return Buffer.concat(stdout);
		} finally {
			this.active.delete(stop);
		}
	}
	/** Stops accepting commands, cancels only owned Unix groups, and awaits direct-child stream closure. */
	close(): Promise<void> {
		this.closing ??= Promise.resolve().then(async () => {
			await Promise.all([...this.active].map((stop) => stop()));
		});
		return this.closing;
	}
}
