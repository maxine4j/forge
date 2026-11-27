import { createLogger } from "@forge/backend-infrastructure/logger";
import type { AccountStatus } from "@forge/contracts";
import { z } from "zod";

import type { IAccountAttemptStore } from "./account-attempt-store.ts";
import type { IAccountProvider } from "./account-provider.ts";
import type { ICodexConnection } from "./codex-connection.ts";
import type { LoginState } from "./types.ts";

const loginSchema = z.object({
	type: z.literal("chatgptDeviceCode"),
	loginId: z.string().min(1).max(256),
	verificationUrl: z
		.url()
		.max(2048)
		.refine((value) => {
			const url = new URL(value);
			return (
				url.protocol === "https:"
				&& url.hostname === "auth.openai.com"
				&& !url.port
				&& !url.username
				&& !url.password
				&& !url.hash
				&& !url.search
				&& url.pathname === "/codex/device"
			);
		}),
	userCode: z.string().regex(/^[A-Z0-9-]{1,128}$/),
});
const accountSchema = z.object({
	requiresOpenaiAuth: z.boolean(),
	account: z
		.discriminatedUnion("type", [
			z.object({
				type: z.literal("chatgpt"),
				email: z.string().min(1).max(320).nullable(),
				planType: z.enum([
					"free",
					"go",
					"plus",
					"pro",
					"prolite",
					"promax",
					"team",
					"self_serve_business_prolite",
					"self_serve_business_usage_based",
					"business",
					"ent26",
					"enterprise_cbp_automation",
					"enterprise_cbp_usage_based",
					"enterprise",
					"edu",
					"edu_plus",
					"edu_pro",
					"sci",
					"sci_plus",
					"unknown",
				]),
			}),
			z.object({ type: z.literal("apiKey") }),
			z.object({ type: z.literal("amazonBedrock"), usesCodexManagedCredentials: z.boolean().optional() }),
		])
		.nullish(),
});
const completionSchema = z.object({
	loginId: z.string().max(256).nullish(),
	success: z.boolean(),
	error: z.string().nullish(),
});

export class CodexAccountClient implements IAccountProvider {
	private readonly log = createLogger(CodexAccountClient.name);
	private login: LoginState = { state: "idle" };
	private loginId: string | undefined;
	private starting = false;
	private readonly earlyCompletions = new Map<string, boolean>();
	private completed: boolean | undefined;
	private loaded = false;
	constructor(
		private readonly connection: ICodexConnection,
		private readonly attempts: IAccountAttemptStore,
	) {
		connection.subscribe((method, params) => this.notification(method, params));
	}
	async status(): Promise<AccountStatus> {
		try {
			await this.restore();
			await this.connection.initialize();
			const result = accountSchema.parse(await this.connection.request("account/read", { refreshToken: false }));
			const account =
				result.account?.type === "chatgpt" ? { name: result.account.email ?? "ChatGPT account" } : undefined;
			if (this.login.state === "pending" && this.completed !== undefined) {
				this.login =
					this.completed && account
						? { state: "completed" }
						: { state: "failed", failure: this.completed ? "verification-failed" : "login-failed" };
				this.loginId = undefined;
				await this.attempts.save("codex", false);
			}
			return { connection: "available", ...(account ? { account } : {}), login: { ...this.login } };
		} catch (err) {
			this.log.warn({ err }, "Could not verify Codex account");
			if (this.login.state === "pending") this.loseConnection();
			return {
				connection: "unavailable",
				login:
					this.login.state === "uncertain" ? { ...this.login } : { state: "failed", failure: "unavailable" },
			};
		}
	}
	async start(): Promise<AccountStatus> {
		if (this.login.state === "pending") return this.status();
		let issued = false;
		try {
			await this.restore();
			if (this.login.state === "uncertain") await this.connection.restart();
			await this.connection.initialize();
			await this.attempts.save("codex", true);
			this.starting = true;
			this.completed = undefined;
			this.earlyCompletions.clear();
			issued = true;
			const result = loginSchema.parse(
				await this.connection.request("account/login/start", { type: "chatgptDeviceCode" }),
			);
			this.loginId = result.loginId;
			this.completed = this.earlyCompletions.get(result.loginId);
			this.login = { state: "pending", verificationUrl: result.verificationUrl, userCode: result.userCode };
			return { connection: "available", login: { ...this.login } };
		} catch (err) {
			this.log.warn({ err }, "Codex login could not start; retry explicitly");
			this.login = issued
				? { state: "uncertain", failure: "connection-lost" }
				: { state: "failed", failure: "login-failed" };
			return { connection: "unavailable", login: { ...this.login } };
		} finally {
			this.starting = false;
			this.earlyCompletions.clear();
		}
	}
	async cancel(): Promise<AccountStatus> {
		try {
			await this.restore();
			if (this.login.state === "uncertain") await this.connection.restart();
			if (this.loginId && this.login.state === "pending") {
				try {
					z.object({ status: z.enum(["canceled", "notFound"]) }).parse(
						await this.connection.request("account/login/cancel", { loginId: this.loginId }),
					);
				} catch (err) {
					this.log.warn({ err }, "Codex cancellation could not be confirmed");
					this.loseConnection();
					return { connection: "unavailable", login: { ...this.login } };
				}
			}
			this.loginId = undefined;
			this.completed = undefined;
			this.login = { state: "cancelled" };
			await this.attempts.save("codex", false);
			return this.status();
		} catch (err) {
			this.log.warn({ err }, "Codex cancellation state could not be persisted");
			this.login = { state: "uncertain", failure: "connection-lost" };
			return { connection: "unavailable", login: { ...this.login } };
		}
	}
	private async restore(): Promise<void> {
		if (this.loaded) return;
		if (await this.attempts.pending("codex")) this.login = { state: "uncertain", failure: "connection-lost" };
		this.loaded = true;
	}
	private notification(method: string, params: unknown): void {
		if (method === "connection/lost") {
			this.loseConnection();
			return;
		}
		if (method !== "account/login/completed") return;
		const result = completionSchema.safeParse(params);
		if (!result.success || !result.data.loginId) return;
		if (this.starting && this.earlyCompletions.size < 16)
			this.earlyCompletions.set(result.data.loginId, result.data.success);
		if (result.data.loginId === this.loginId && this.login.state === "pending")
			this.completed = result.data.success;
	}
	private loseConnection(): void {
		if (this.login.state === "pending" || this.starting)
			this.login = { state: "uncertain", failure: "connection-lost" };
		this.loginId = undefined;
		this.completed = undefined;
	}
}
