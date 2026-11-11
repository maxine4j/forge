import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { usernameSchema } from "../auth/access-service.ts";
import type { ForgeConfiguration } from "./types.ts";

const nonemptyNumber = z.union([z.number(), z.string().trim().min(1)]).transform((value) => Number(value));
const schema = z.object({
	owner: usernameSchema,
	origin: z
		.string()
		.url()
		.refine((value) => {
			if (!URL.canParse(value)) return false;
			const url = new URL(value);
			return url.protocol === "https:" && value === url.origin;
		}),
	dataDirectory: z.string().refine(isAbsolute),
	port: z.coerce.number().int().min(1).max(65535),
	cost: z.object({
		monthlyAud: nonemptyNumber.pipe(z.number().nonnegative()),
		audPerUsd: nonemptyNumber.pipe(z.number().positive()),
		exchangeDate: z.iso.date(),
	}),
	importHosts: z.array(
		z
			.string()
			.regex(/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
			.refine((host) => host.includes(".") && !host.includes("..") && !isIP(host)),
	),
});
export interface IConfiguration {
	load(): ForgeConfiguration;
}
export class Configuration implements IConfiguration {
	constructor(private readonly environment: Record<string, string | undefined>) {}
	load(): ForgeConfiguration {
		const audPerUsd = this.environment["FORGE_COST_AUD_PER_USD"];
		const exchangeDate = this.environment["FORGE_COST_EXCHANGE_DATE"];
		const exchange =
			audPerUsd === undefined && exchangeDate === undefined
				? { audPerUsd: 1 / 0.6924, exchangeDate: "2026-11-10" }
				: { audPerUsd, exchangeDate };
		const result = schema.safeParse({
			owner: this.environment["FORGE_OWNER"],
			origin: this.environment["FORGE_ORIGIN"],
			dataDirectory: this.environment["FORGE_DATA_DIRECTORY"] ?? "/data",
			port: this.environment["FORGE_PORT"] ?? "8080",
			cost: {
				monthlyAud: this.environment["FORGE_CODEX_MONTHLY_AUD"] ?? 30,
				...exchange,
			},
			importHosts:
				this.environment["FORGE_IMPORT_HOSTS"]?.split(",").map((host) => host.trim().toLowerCase()) ?? [],
		});
		if (!result.success)
			throw new Error(
				"Invalid Forge configuration: check owner, origin, data directory, port, import hosts and cost settings",
				{ cause: result.error },
			);
		return result.data;
	}
}
