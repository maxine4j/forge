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
	]) {
		expect(() => new Configuration({ ...env, ...change }).load()).toThrow("Invalid Forge configuration");
	}
	expect(new Configuration({ ...env, FORGE_IMPORT_HOSTS: undefined }).load().importHosts).toEqual([]);
});
