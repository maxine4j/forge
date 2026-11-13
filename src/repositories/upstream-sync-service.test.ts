import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import type { ProjectRecord } from "../projects/types.ts";
import type { UpstreamSyncResult } from "./types.ts";
import type { IUpstreamSyncClient } from "./upstream-sync-client.ts";
import { UpstreamSyncService } from "./upstream-sync-service.ts";

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
		status: vi.fn<IUpstreamSyncClient["status"]>().mockResolvedValue({ branch: "main", ahead: 2, behind: 1 }),
		sync: vi
			.fn<IUpstreamSyncClient["sync"]>()
			.mockResolvedValue({ outcome: "synced", branch: "main", head: "a".repeat(40) }),
	};
	const store = { get: vi.fn().mockResolvedValue(record) };
	const repositories = { hasUpstream: vi.fn().mockResolvedValue(true) };
	return { service: new UpstreamSyncService(client, store, access, repositories), client, store, repositories };
};

test("uses actual upstream presence and enforces owner access", async () => {
	const { service, store } = setup();
	await expect(service.status({ username: "stranger" }, project.id)).rejects.toThrow();
	expect(store.get).not.toHaveBeenCalled();
	expect(await service.status(owner, project.id)).toEqual({ state: "ready", branch: "main", ahead: 2, behind: 1 });
	expect(await service.sync(owner, project.id)).toEqual({ outcome: "synced", branch: "main", head: "a".repeat(40) });
});

test.each([undefined, "https://github.com/maxine4j/different", "https://other.example/maxine4j/forge"])(
	"saved source %s alone does not enable sync",
	async (source) => {
		const { source: _source, ...record } = project;
		const { service, client, repositories } = setup({ ...record, name: "Forge", ...(source ? { source } : {}) });
		repositories.hasUpstream.mockResolvedValue(false);
		expect(await service.status(owner, project.id)).toEqual({ state: "unconfigured" });
		expect(await service.sync(owner, project.id)).toEqual({ outcome: "unconfigured" });
		expect(client.status).not.toHaveBeenCalled();
		expect(client.sync).not.toHaveBeenCalled();
	},
);

test.each([undefined, "https://example.com/team/repository"])(
	"upstream presence qualifies arbitrary source %s",
	async (source) => {
		const { source: _source, ...record } = project;
		const { service } = setup({ ...record, ...(source ? { source } : {}) });
		expect(await service.status(owner, project.id)).toMatchObject({ state: "ready", branch: "main" });
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
	expect(reads).toEqual(Array(2).fill({ state: "ready", branch: "main", ahead: 2, behind: 1 }));
	expect(client.status).toHaveBeenCalledTimes(1);
	const operation = Promise.withResolvers<UpstreamSyncResult>();
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
		operation.resolve({ outcome: "synced", branch: "main", head: "a".repeat(40) });
		await first;
	}
	expect(client.sync).toHaveBeenCalledTimes(1);
});
