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
		...[
			"ftp://relay",
			"http://user@relay",
			"http://relay/",
			"http://relay/path",
			"http://relay?",
			"http://relay#",
		].map((FORGE_OLLAMA_RELAY_ORIGIN) => ({ FORGE_OLLAMA_RELAY_ORIGIN })),
	]) {
		expect(() => new Configuration({ ...env, ...change }).load()).toThrow("Invalid Forge configuration");
	}
	expect(new Configuration({ ...env, FORGE_IMPORT_HOSTS: undefined }).load().importHosts).toEqual([]);
	expect(new Configuration({ ...env, FORGE_OLLAMA_RELAY_ORIGIN: "http://relay:8081" }).load().ollamaRelayOrigin).toBe(
		"http://relay:8081",
	);
});
