import type { AccountStatus } from "@forge/contracts";

export interface IAccountProvider {
	/** Verifies credentials with the provider; returns sanitized unavailable state on infrastructure failure. */
	status(): Promise<AccountStatus>;
	/** At most one pending attempt. No automatic retry after an uncertain result. */
	start(): Promise<AccountStatus>;
	/** Cancels the active attempt; never removes stored credentials. */
	cancel(): Promise<AccountStatus>;
}
