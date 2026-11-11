import { expect, test } from "vitest";

import { Configuration } from "./configuration.ts";

test("configuration requires explicit owner and HTTPS origin, and validates import hosts", () => {
	const env = {
		FORGE_OWNER: "Owner",
		FORGE_ORIGIN: "https://forge.example.com",
		FORGE_IMPORT_HOSTS: "github.com,git.example.com",
	};
	expect(new Configuration(env).load()).toEqual({
		owner: "owner",
		origin: "https://forge.example.com",
		dataDirectory: "/data",
		port: 8080,
		importHosts: ["github.com", "git.example.com"],
		cost: { monthlyAud: 30, audPerUsd: 1 / 0.6924, exchangeDate: "2026-11-10" },
	});
	for (const change of [
		{ FORGE_OWNER: undefined },
		{ FORGE_OWNER: "owner\n" },
		{ FORGE_ORIGIN: "http://forge.example.com" },
		{ FORGE_ORIGIN: "https://forge.example.com/path" },
		{ FORGE_PORT: "0" },
		{ FORGE_IMPORT_HOSTS: "127.0.0.1" },
		{ FORGE_IMPORT_HOSTS: "*.github.com" },
		{ FORGE_DATA_DIRECTORY: "relative" },
		{ FORGE_CODEX_MONTHLY_AUD: "-30" },
		{ FORGE_CODEX_MONTHLY_AUD: "" },
		{ FORGE_COST_AUD_PER_USD: "1.5" },
		{ FORGE_COST_EXCHANGE_DATE: "2026-11-11" },
		{ FORGE_COST_AUD_PER_USD: "0", FORGE_COST_EXCHANGE_DATE: "2026-11-10" },
	]) {
		expect(() => new Configuration({ ...env, ...change }).load()).toThrow("Invalid Forge configuration");
	}
	expect(new Configuration({ ...env, FORGE_IMPORT_HOSTS: undefined }).load().importHosts).toEqual([]);
	expect(
		new Configuration({
			...env,
			FORGE_CODEX_MONTHLY_AUD: "50",
			FORGE_COST_AUD_PER_USD: "1.5",
			FORGE_COST_EXCHANGE_DATE: "2026-11-11",
		}).load().cost,
	).toEqual({ monthlyAud: 50, audPerUsd: 1.5, exchangeDate: "2026-11-11" });
});
