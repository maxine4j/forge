import { expect, test } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import { ProjectUnavailableError } from "../projects/errors.ts";
import type { IRepositoryBrowserClient } from "./repository-browser-client.ts";
import { RepositoryBrowserService } from "./repository-browser-service.ts";

test("browsing rechecks owner authorization and ready project state before Git access", async () => {
	let reads = 0;
	const client: IRepositoryBrowserClient = {
		commit: async () => {
			reads++;
			return { head: "a".repeat(40) };
		},
		branches: async () => {
			reads++;
			return [];
		},
		tree: async () => {
			throw new Error("unused");
		},
		file: async () => {
			throw new Error("unused");
		},
		history: async () => {
			throw new Error("unused");
		},
	};
	const id = "123e4567-e89b-42d3-a456-426614174000";
	let status: "ready" | "failed" = "failed";
	const service = new RepositoryBrowserService(
		client,
		{ get: async () => ({ id, name: "Project", status, createdAt: "2026-11-02T00:00:00.000Z" }) },
		new AccessService({ owner: "owner", origin: "https://forge.example" }),
	);
	await expect(service.branches({ username: "intruder" }, id)).rejects.toThrow("Access denied");
	await expect(service.branches({ username: "owner" }, id)).rejects.toThrow(ProjectUnavailableError);
	expect(reads).toBe(0);
	status = "ready";
	expect(await service.branches({ username: "owner" }, id)).toEqual([]);
	expect(reads).toBe(1);
});
