import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import { ProjectService } from "./project-service.ts";
import type { IProjectStore } from "./project-store.ts";
import type { ProjectRecord } from "./types.ts";

const id = "123e4567-e89b-42d3-a456-426614174000";
const fixture = () => {
	const records = new Map<string, ProjectRecord>();
	const store = {
		insert: vi.fn(async (record: ProjectRecord) => {
			records.set(record.id, { ...record });
		}),
		get: vi.fn(async (key: string) => records.get(key)),
		list: vi.fn(async () => [...records.values()]),
		setStatus: vi.fn(async (key: string, status: ProjectRecord["status"]) => {
			records.get(key)!.status = status;
		}),
	} satisfies IProjectStore;
	const repositories = { prepare: vi.fn(async () => {}), verify: vi.fn(async () => {}) };
	const access = new AccessService({ owner: "owner", origin: "https://forge.example.com" });
	const service = new ProjectService(
		store,
		repositories,
		access,
		() => id,
		() => new Date("2026-11-02T00:00:00Z"),
	);
	return { service, store, records, repositories };
};

test("persist intent before Git, then report ready without source details", async () => {
	const { service, store, repositories, records } = fixture();
	repositories.prepare.mockImplementation(async () => {
		expect(records.get(id)?.status).toBe("creating");
	});
	expect(
		await service.create({ username: "owner" }, { name: "Project", source: "https://github.com/owner/repo" }),
	).toEqual({ id, name: "Project", status: "ready", createdAt: "2026-11-02T00:00:00.000Z" });
	expect(store.insert).toHaveBeenCalledOnce();
	expect(repositories.prepare).toHaveBeenCalledWith(id, "https://github.com/owner/repo");
	expect(await service.list({ username: "owner" })).toHaveLength(1);
	await expect(service.get({ username: "owner" }, "123e4567-e89b-42d3-a456-426614174001")).rejects.toThrow(
		"Project not found",
	);
});

test("authorization and domain validation run before effects even for non-HTTP callers", async () => {
	const { service, store } = fixture();
	await expect(service.create({ username: "other" }, { name: "Project" })).rejects.toThrow("Access denied");
	await expect(service.create({ username: "owner" }, { name: "Project", source: "/etc" })).rejects.toThrow(
		"Invalid project request",
	);
	expect(store.insert).not.toHaveBeenCalled();
});

test("Git failure retains failed intent and sanitizes failure; explicit retry can finish it", async () => {
	const { service, records, repositories } = fixture();
	repositories.prepare.mockRejectedValueOnce(new Error("SECRET"));
	await expect(service.create({ username: "owner" }, { name: "Project" })).rejects.toThrow(
		/^Project repository unavailable$/,
	);
	expect(records.get(id)?.status).toBe("failed");
	expect((await service.retry({ username: "owner" }, id)).status).toBe("ready");
});

test("startup reconciles creating intents and verifies ready repository ownership without repeating failed imports", async () => {
	const { service, records, repositories } = fixture();
	const base = { id, name: "Project", createdAt: "2026-11-02T00:00:00.000Z" };
	records.set(id, { ...base, status: "creating" });
	await service.recover();
	expect(records.get(id)?.status).toBe("ready");
	await service.recover();
	expect(repositories.prepare).toHaveBeenCalledOnce();
	expect(repositories.verify).toHaveBeenCalledWith(id);
	repositories.verify.mockRejectedValueOnce(new Error("unrelated path"));
	await service.recover();
	expect(records.get(id)?.status).toBe("failed");
	await service.recover();
	expect(repositories.prepare).toHaveBeenCalledOnce();
});
