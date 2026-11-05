import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

import { chmod, isFileError, lstat, mkdir } from "@forge/backend-infrastructure/file";
import { createLogger } from "@forge/backend-infrastructure/logger";
import type { ISleep } from "@forge/backend-infrastructure/sleep";

import type {
	AccountProcessConfiguration,
	AccountProcessHandle,
	AccountProcessSpec,
	IAccountDiagnostics,
} from "./types.ts";

export class AccountProcessError extends Error {
	constructor(options?: ErrorOptions) {
		super("Account process unavailable", options);
		this.name = "AccountProcessError";
	}
}
export interface IAccountProcess {
	/** Restricts persistent credential directories; call before spawning. Throws AccountProcessError. */
	initialize(): Promise<void>;
	/** Starts a private Unix process group, with no inherited account tokens. Throws AccountProcessError. */
	spawn(spec: AccountProcessSpec): AccountProcessHandle;
}
export class AccountProcess implements IAccountProcess {
	private ready = false;
	private codexOwned = false;
	constructor(
		private readonly config: AccountProcessConfiguration,
		private readonly sleep: ISleep,
		private readonly log: IAccountDiagnostics = createLogger(AccountProcess.name),
	) {}
	async initialize(): Promise<void> {
		try {
			for (const name of ["codex", "github"]) {
				const directory = join(this.config.dataDirectory, name);
				await mkdir(directory, { recursive: true, mode: 0o700 });
				if (!(await lstat(directory)).isDirectory())
					throw new Error("Credential home must be an owned directory");
				await chmod(directory, 0o700);
			}
			for (const path of [
				join(this.config.dataDirectory, "codex/auth.json"),
				join(this.config.dataDirectory, "github/hosts.yml"),
			]) {
				try {
					if (!(await lstat(path)).isFile()) throw new Error("Credential path must be a regular file");
					await chmod(path, 0o600);
				} catch (err) {
					if (!isFileError(err, "ENOENT")) throw err;
				}
			}
			this.ready = true;
		} catch (cause) {
			throw new AccountProcessError({ cause });
		}
	}
	spawn(spec: AccountProcessSpec): AccountProcessHandle {
		if (!this.ready || (spec.program === "codex" && this.codexOwned)) throw new AccountProcessError();
		const codex = spec.program === "codex";
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(codex ? this.config.codexExecutable : this.config.githubExecutable, spec.arguments, {
				detached: true,
				stdio: ["pipe", "pipe", "pipe"],
				cwd: this.config.dataDirectory,
				env: {
					PATH: this.config.path,
					HOME: this.config.dataDirectory,
					LANG: "C",
					LC_ALL: "C",
					TERM: "dumb",
					NO_COLOR: "1",
					CODEX_HOME: join(this.config.dataDirectory, "codex"),
					GH_CONFIG_DIR: join(this.config.dataDirectory, "github"),
					GH_HOST: "github.com",
					GH_PROMPT_DISABLED: "1",
					BROWSER: "/bin/true",
					GH_BROWSER: "/bin/true",
				},
			});
		} catch (cause) {
			throw new AccountProcessError({ cause });
		}
		if (codex) this.codexOwned = true;
		let failure: unknown;
		let stderr = "";
		let stderrBytes = 0;
		let outputBytes = 0;
		let stopPromise: Promise<void> | undefined;
		let exited = false;
		let expectedStop = false;
		const signalGroup = (signal: NodeJS.Signals): boolean => {
			if (!child.pid) return false;
			try {
				process.kill(-child.pid, signal);
				return true;
			} catch (err) {
				if (!isFileError(err, "ESRCH")) this.log.error({ err }, "Account process group signal failed");
				return false;
			}
		};
		const done = new Promise<number>((resolve, reject) => {
			child.on("error", (err) => {
				failure = err;
			});
			child.stdin.on("error", (err) => {
				failure = err;
				signalGroup("SIGKILL");
			});
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => {
				outputBytes += Buffer.byteLength(chunk);
				if (spec.outputLimit !== undefined && outputBytes > spec.outputLimit) {
					failure = new Error("Account stdout exceeded bound");
					signalGroup("SIGKILL");
					return;
				}
				try {
					spec.onOutput(chunk);
				} catch (err) {
					failure = err;
					signalGroup("SIGKILL");
				}
			});
			child.stderr.on("data", (chunk: string) => {
				outputBytes += Buffer.byteLength(chunk);
				stderrBytes += Buffer.byteLength(chunk);
				stderr = Buffer.from(stderr + chunk)
					.subarray(-65536)
					.toString("utf8");
				if (
					(!codex && stderrBytes > 65536)
					|| (spec.outputLimit !== undefined && outputBytes > spec.outputLimit)
				) {
					failure = new Error("Account stderr exceeded bound");
					signalGroup("SIGKILL");
					return;
				}
				if (spec.onStderr) {
					try {
						spec.onStderr(chunk);
					} catch (err) {
						failure = err;
						signalGroup("SIGKILL");
					}
				}
			});
			child.on("exit", () => {
				exited = true;
				signalGroup("SIGKILL");
			});
			child.on("close", (code) => {
				exited = true;
				if (codex) this.codexOwned = false;
				if (failure) reject(new AccountProcessError({ cause: failure }));
				else {
					if (code !== 0 && !expectedStop && !spec.expectedExitCodes?.includes(code ?? -1))
						this.log.warn(
							{ err: new Error(stderr), exitCode: code },
							"Account command exited unsuccessfully",
						);
					resolve(code ?? -1);
				}
			});
		});
		// Callers may observe completion after stream events; prevent premature unhandled rejection.
		void done.catch(() => {});
		return {
			done,
			write: (data) => {
				if (exited || !child.stdin.writable) throw new AccountProcessError();
				child.stdin.write(data);
			},
			stop: () => {
				expectedStop = true;
				stopPromise ??= (async () => {
					if (!exited && signalGroup("SIGTERM")) {
						const timer = new AbortController();
						await Promise.race([done.catch(() => {}), this.sleep(1000, timer.signal).catch(() => {})]);
						timer.abort();
						signalGroup("SIGKILL");
					}
					await done.catch(() => {});
				})();
				return stopPromise;
			},
		};
	}
}
