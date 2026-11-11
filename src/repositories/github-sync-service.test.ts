import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import type { ProjectRecord } from "../projects/types.ts";
import type { IGithubSyncClient } from "./github-sync-client.ts";
import { GithubSyncService } from "./github-sync-service.ts";
import type { GithubSyncResult } from "./types.ts";

const owner = { username: "owner" };
const project: ProjectRecord = {
	id: "123e4567-e89b-42d3-a456-426614174000",
	name: "Renamed project",
	status: "ready",
	source: "https://github.com/Maxine4j/Forge",
	createdAt: "2026-11-01T00:00:00.000Z",
};
const setup = (record: ProjectRecord = project) => {
	const access = new AccessService({ owner: owner.username, origin: "https://forge.example" });
	const client = {
		status: vi.fn<IGithubSyncClient["status"]>().mockResolvedValue({ ahead: 2, behind: 1 }),
		sync: vi.fn<IGithubSyncClient["sync"]>().mockResolvedValue({ outcome: "synced", head: "a".repeat(40) }),
	};
	const store = { get: vi.fn().mockResolvedValue(record) };
	return { service: new GithubSyncService(client, store, access), client, store };
};

test("matches the saved Forge import source and enforces owner access", async () => {
	const { service, store } = setup();
	await expect(service.status({ username: "stranger" }, project.id)).rejects.toThrow();
	expect(store.get).not.toHaveBeenCalled();
	expect(await service.status(owner, project.id)).toEqual({ state: "ready", ahead: 2, behind: 1 });
	expect(await service.sync(owner, project.id)).toEqual({ outcome: "synced", head: "a".repeat(40) });
});

test.each([undefined, "https://github.com/maxine4j/different", "https://other.example/maxine4j/forge"])(
	"does not enable sync for source %s",
	async (source) => {
		const { source: _source, ...record } = project;
		const { service, client } = setup({ ...record, name: "Forge", ...(source ? { source } : {}) });
		expect(await service.status(owner, project.id)).toEqual({ state: "unconfigured" });
		expect(await service.sync(owner, project.id)).toEqual({ outcome: "unconfigured" });
		expect(client.status).not.toHaveBeenCalled();
		expect(client.sync).not.toHaveBeenCalled();
	},
);

test("reports unavailable reads safely and allows retry after an unsuccessful sync", async () => {
	const { service, client } = setup();
	client.status.mockRejectedValueOnce(new Error("private diagnostic"));
	client.sync.mockRejectedValueOnce(new Error("private diagnostic"));
	expect(await service.status(owner, project.id)).toEqual({ state: "unavailable" });
	expect(await service.sync(owner, project.id)).toEqual({ outcome: "unavailable" });
	expect(await service.sync(owner, project.id)).toMatchObject({ outcome: "synced" });
});

test("deduplicates drift reads and rejects concurrent syncs for the Forge remote", async () => {
	const { service, client } = setup();
	const reads = await Promise.all([service.status(owner, project.id), service.status(owner, project.id)]);
	expect(reads).toEqual(Array(2).fill({ state: "ready", ahead: 2, behind: 1 }));
	expect(client.status).toHaveBeenCalledTimes(1);
	const operation = Promise.withResolvers<GithubSyncResult>();
	const started = Promise.withResolvers<void>();
	client.sync.mockImplementationOnce(() => {
		started.resolve();
		return operation.promise;
	});
	const first = service.sync(owner, project.id);
	await started.promise;
	try {
		expect(await service.sync(owner, project.id)).toEqual({ outcome: "busy" });
	} finally {
		operation.resolve({ outcome: "synced", head: "a".repeat(40) });
		await first;
	}
	expect(client.sync).toHaveBeenCalledTimes(1);
});
