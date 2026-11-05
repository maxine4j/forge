import { stripVTControlCharacters } from "node:util";

import { createLogger } from "@forge/backend-infrastructure/logger";
import type { ISleep } from "@forge/backend-infrastructure/sleep";
import type { AccountStatus } from "@forge/contracts";
import { z } from "zod";

import { usernameSchema } from "../auth/access-service.ts";
import type { IAccountAttemptStore } from "./account-attempt-store.ts";
import type { IAccountProcess } from "./account-process.ts";
import type { IAccountProvider } from "./account-provider.ts";
import type { AccountProcessHandle, LoginState } from "./types.ts";

export class GithubAccountClient implements IAccountProvider {
	private readonly log = createLogger(GithubAccountClient.name);
	private login: LoginState = { state: "idle" };
	private attempt: { handle: AccountProcessHandle; result?: number; timer: AbortController } | undefined;
	private loaded = false;
	constructor(
		private readonly processes: IAccountProcess,
		private readonly sleep: ISleep,
		private readonly attempts: IAccountAttemptStore,
		private readonly commandDeadlineMs: number = 15_000,
		private readonly loginDeadlineMs: number = 900_000,
	) {}
	async status(): Promise<AccountStatus> {
		try {
			await this.restore();
			const account = await this.verify();
			if (this.attempt?.result !== undefined) {
				const succeeded = this.attempt.result === 0 && !!account;
				this.attempt.timer.abort();
				this.attempt = undefined;
				this.login = succeeded ? { state: "completed" } : { state: "failed", failure: "verification-failed" };
				await this.attempts.save("github", false);
			}
			return {
				connection: "available",
				...(account ? { account: { name: account } } : {}),
				login: { ...this.login },
			};
		} catch (err) {
			this.log.warn(
				{ err },
				"Could not verify GitHub account; check gh installation, connectivity and credential directory permissions",
			);
			return {
				connection: "unavailable",
				login:
					this.login.state === "uncertain"
						? { ...this.login }
						: this.login.state === "pending"
							? { ...this.login, failure: "verification-failed" }
							: { state: "failed", failure: "verification-failed" },
			};
		}
	}
	async start(): Promise<AccountStatus> {
		if (this.attempt?.result !== undefined) {
			this.attempt.timer.abort();
			await this.attempt.handle.stop();
			this.attempt = undefined;
		}
		if (this.attempt) return { connection: "available", login: { ...this.login } };
		let buffer = "";
		let ready: () => void = () => {};
		const prompt = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const timer = new AbortController();
		let acceptingPrompt = true;
		const acceptPrompt = (chunk: string): void => {
			if (!acceptingPrompt) return;
			buffer = (buffer + chunk).slice(-65536);
			const clean = stripVTControlCharacters(buffer);
			const code = /First copy your one-time code: ([A-Z0-9-]{1,128})\r?\n/.exec(clean)?.at(1);
			const url = /Open this URL to continue in your web browser: (\S+)\r?\n/.exec(clean)?.at(1);
			if (code && url === "https://github.com/login/device") {
				this.login = { state: "pending", verificationUrl: url, userCode: code };
				ready();
			}
		};
		try {
			await this.restore();
			await this.processes.initialize();
			await this.attempts.save("github", true);
			const handle = this.processes.spawn({
				program: "github",
				arguments: [
					"auth",
					"login",
					"--hostname",
					"github.com",
					"--git-protocol",
					"https",
					"--web",
					"--insecure-storage",
				],
				outputLimit: 65536,
				onOutput: acceptPrompt,
				onStderr: acceptPrompt,
			});
			const attempt = { handle, timer, result: undefined as number | undefined };
			this.attempt = attempt;
			this.login = { state: "pending" };
			void handle.done.then(
				(code) => {
					acceptingPrompt = false;
					timer.abort();
					if (this.attempt === attempt) attempt.result = code;
				},
				(err: unknown) => {
					acceptingPrompt = false;
					timer.abort();
					this.log.warn({ err }, "GitHub login process failed");
					if (this.attempt === attempt) attempt.result = -1;
				},
			);
			void this.sleep(this.loginDeadlineMs, timer.signal)
				.then(
					async () => {
						if (this.attempt !== attempt) return;
						acceptingPrompt = false;
						this.attempt = undefined;
						this.login = { state: "failed", failure: "login-failed" };
						await handle.stop();
						await this.attempts.save("github", false);
					},
					() => {},
				)
				.catch((err: unknown) => {
					this.log.error({ err }, "GitHub timeout cleanup failed");
					this.login = { state: "uncertain", failure: "connection-lost" };
				});
			const promptTimer = new AbortController();
			const result = await Promise.race([
				prompt.then(() => "prompt" as const),
				handle.done.then(() => "exit" as const),
				this.sleep(this.commandDeadlineMs, promptTimer.signal).then(() => "timeout" as const),
			]).finally(() => promptTimer.abort());
			if (result === "exit") return this.status();
			if (result === "timeout") throw new Error("GitHub device prompt deadline exceeded");
			return { connection: "available", login: { ...this.login } };
		} catch (err) {
			acceptingPrompt = false;
			this.log.warn({ err }, "GitHub login failed; retry and check gh installation, network and permissions");
			timer.abort();
			const attempt = this.attempt;
			this.attempt = undefined;
			await attempt?.handle.stop();
			this.login = { state: "failed", failure: "login-failed" };
			try {
				await this.attempts.save("github", false);
			} catch (cause) {
				this.log.error({ err: cause }, "GitHub attempt state unavailable");
				this.login = { state: "uncertain", failure: "connection-lost" };
			}
			return { connection: "unavailable", login: { ...this.login } };
		}
	}
	async cancel(): Promise<AccountStatus> {
		const attempt = this.attempt;
		this.attempt = undefined;
		attempt?.timer.abort();
		await attempt?.handle.stop();
		this.login = { state: "cancelled" };
		try {
			await this.attempts.save("github", false);
			this.loaded = true;
			return { connection: "available", login: { ...this.login } };
		} catch (err) {
			this.log.warn({ err }, "GitHub cancellation state unavailable");
			this.login = { state: "uncertain", failure: "connection-lost" };
			return { connection: "unavailable", login: { ...this.login } };
		}
	}
	async close(): Promise<void> {
		await this.cancel();
	}
	private async restore(): Promise<void> {
		if (this.loaded) return;
		if (await this.attempts.pending("github")) this.login = { state: "uncertain", failure: "connection-lost" };
		this.loaded = true;
	}
	private async verify(): Promise<string | undefined> {
		await this.processes.initialize();
		let output = "";
		let diagnostics = "";
		const handle = this.processes.spawn({
			program: "github",
			arguments: ["api", "--include", "--hostname", "github.com", "user"],
			expectedExitCodes: [1, 4],
			outputLimit: 65536,
			onOutput: (chunk) => {
				output += chunk;
			},
			onStderr: (chunk) => {
				diagnostics += chunk;
			},
		});
		const timer = new AbortController();
		try {
			const code = await Promise.race([
				handle.done,
				this.sleep(this.commandDeadlineMs, timer.signal).then(() => {
					throw new Error("GitHub verification deadline exceeded");
				}),
			]);
			if (code === 4) return undefined;
			const normalized = output.replaceAll("\r\n", "\n");
			const status = /^HTTP\/\d(?:\.\d)? (\d{3})[^\n]*\n/.exec(normalized)?.at(1);
			if (code === 1 && status === "401") return undefined;
			if (code !== 0) throw new Error("GitHub verification failed");
			const body = normalized.indexOf("\n\n");
			if (status !== "200" || body < 0) throw new Error("Invalid GitHub verification response");
			return z.object({ login: usernameSchema }).parse(JSON.parse(normalized.slice(body + 2))).login;
		} catch (cause) {
			throw new Error("GitHub verification failed", {
				cause: new AggregateError([cause, new Error(diagnostics), new Error(output)], "GitHub CLI diagnostics"),
			});
		} finally {
			timer.abort();
			await handle.stop();
		}
	}
}
