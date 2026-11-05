import type { AccountProvider, AccountStatus, AccountsStatus } from "@forge/contracts";

import type { IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import type { IAccountProvider } from "./account-provider.ts";

export interface IAccountService {
	status(actor: Actor): Promise<AccountsStatus>;
	start(actor: Actor, provider: AccountProvider): Promise<AccountStatus>;
	cancel(actor: Actor, provider: AccountProvider): Promise<AccountStatus>;
}
export class AccountService implements IAccountService {
	private queue: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly access: IAccessService,
		private readonly codex: IAccountProvider,
		private readonly github: IAccountProvider,
	) {}
	async status(actor: Actor): Promise<AccountsStatus> {
		this.access.assertOwner(actor);
		return this.serialize(async () => {
			const [codex, github] = await Promise.all([this.codex.status(), this.github.status()]);
			return { codex, github };
		});
	}
	async start(actor: Actor, provider: AccountProvider): Promise<AccountStatus> {
		this.access.assertOwner(actor);
		return this.serialize(() => this.provider(provider).start());
	}
	async cancel(actor: Actor, provider: AccountProvider): Promise<AccountStatus> {
		this.access.assertOwner(actor);
		return this.serialize(() => this.provider(provider).cancel());
	}
	private provider(provider: AccountProvider): IAccountProvider {
		return provider === "codex" ? this.codex : this.github;
	}
	private serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation);
		this.queue = result.catch(() => {});
		return result;
	}
}
