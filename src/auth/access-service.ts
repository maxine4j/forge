import { z } from "zod";

import type { Actor, AccessConfiguration } from "./types.ts";

export const usernameSchema = z
	.string()
	.regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/)
	.refine((value) => !value.includes("--"))
	.transform((value) => value.toLowerCase());
export class AccessDeniedError extends Error {
	constructor() {
		super("Access denied");
		this.name = "AccessDeniedError";
	}
}
export interface IAccessService {
	/** PaaS assertions are trusted only behind private ingress with no direct HTTP access. */
	authorize(username: unknown, origin: unknown, mutation: boolean): Actor;
	/** Services enforce owner policy regardless of their caller. Throws AccessDeniedError. */
	assertOwner(actor: Actor): void;
}
export class AccessService implements IAccessService {
	constructor(private readonly config: AccessConfiguration) {}
	authorize(username: unknown, origin: unknown, mutation: boolean): Actor {
		const result = usernameSchema.safeParse(username);
		if (!result.success || (mutation && origin !== this.config.origin)) throw new AccessDeniedError();
		const actor = { username: result.data };
		this.assertOwner(actor);
		return actor;
	}
	assertOwner(actor: Actor): void {
		const result = usernameSchema.safeParse(actor.username);
		if (!result.success || result.data !== this.config.owner.toLowerCase()) throw new AccessDeniedError();
	}
}
