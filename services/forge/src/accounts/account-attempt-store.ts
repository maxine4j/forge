import { accountProviderSchema, type AccountProvider } from "@forge/contracts";
import { z } from "zod";

import type { IDatabase } from "../database/sqlite-database.ts";

export class AccountAttemptError extends Error {
	constructor(options?: ErrorOptions) {
		super("Account attempt state unavailable", options);
		this.name = "AccountAttemptError";
	}
}
export interface IAccountAttemptStore {
	/** A pending marker after restart means uncertain, never permission to replay login. Throws AccountAttemptError. */
	pending(provider: AccountProvider): Promise<boolean>;
	/** Persist intent before starting a login; no codes, IDs or credentials are stored here. Throws AccountAttemptError. */
	save(provider: AccountProvider, pending: boolean): Promise<void>;
}
export class AccountAttemptStore implements IAccountAttemptStore {
	constructor(private readonly database: IDatabase) {}
	async initialize(): Promise<void> {
		try {
			await this.database.run(
				"CREATE TABLE IF NOT EXISTS account_login_attempts (provider TEXT PRIMARY KEY CHECK (provider IN ('codex','github')), pending INTEGER NOT NULL CHECK (pending IN (0,1)))",
			);
		} catch (cause) {
			throw new AccountAttemptError({ cause });
		}
	}
	async pending(provider: AccountProvider): Promise<boolean> {
		try {
			accountProviderSchema.parse(provider);
			const rows = await this.database.all("SELECT pending FROM account_login_attempts WHERE provider = ?", [
				provider,
			]);
			return rows.length === 0
				? false
				: z.object({ pending: z.union([z.literal(0), z.literal(1)]) }).parse(rows.at(0)).pending === 1;
		} catch (cause) {
			throw new AccountAttemptError({ cause });
		}
	}
	async save(provider: AccountProvider, pending: boolean): Promise<void> {
		try {
			accountProviderSchema.parse(provider);
			z.boolean().parse(pending);
			await this.database.run(
				"INSERT INTO account_login_attempts (provider, pending) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET pending = excluded.pending",
				[provider, pending ? 1 : 0],
			);
		} catch (cause) {
			throw new AccountAttemptError({ cause });
		}
	}
}
