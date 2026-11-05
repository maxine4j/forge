import { accountProviderSchema, accountStatusSchema, accountsStatusSchema } from "@forge/contracts";
import Router from "@koa/router";
import { z } from "zod";

import type { Actor } from "../auth/types.ts";
import type { IAccountService } from "./account-service.ts";

class InvalidAccountRequestError extends Error {
	readonly status = 400;
	constructor() {
		super("Invalid account request");
	}
}
export interface IAccountRouter {
	create(): Router<{ actor: Actor }>;
}
export class AccountRouter implements IAccountRouter {
	constructor(private readonly accounts: IAccountService) {}
	create(): Router<{ actor: Actor }> {
		const router = new Router<{ actor: Actor }>({ prefix: "/api/accounts" });
		router.get("/", async (ctx) => {
			ctx.body = accountsStatusSchema.parse(await this.accounts.status(ctx.state.actor));
		});
		for (const action of ["login", "retry", "cancel"] as const) {
			router.post(`/:provider/${action}`, async (ctx) => {
				const provider = accountProviderSchema.safeParse(ctx.params["provider"]);
				if (
					!provider.success
					|| !z.union([z.undefined(), z.strictObject({})]).safeParse(ctx.request.body).success
				)
					throw new InvalidAccountRequestError();
				ctx.body = accountStatusSchema.parse(
					await (action === "cancel"
						? this.accounts.cancel(ctx.state.actor, provider.data)
						: this.accounts.start(ctx.state.actor, provider.data)),
				);
			});
		}
		return router;
	}
}
