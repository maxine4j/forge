import { isIP } from "node:net";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { usernameSchema } from "../auth/access-service.ts";
import type { ForgeConfiguration } from "./types.ts";

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
		const result = schema.safeParse({
			owner: this.environment["FORGE_OWNER"],
			origin: this.environment["FORGE_ORIGIN"],
			dataDirectory: this.environment["FORGE_DATA_DIRECTORY"] ?? "/data",
			port: this.environment["FORGE_PORT"] ?? "8080",
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
