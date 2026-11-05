import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import type { IProjectService } from "../projects/project-service.ts";
import type { IWorkspaceClient } from "./workspace-client.ts";
import type { IWorkspaceDiffClient } from "./workspace-diff-client.ts";
import { WorkspaceService } from "./workspace-service.ts";

test("owner authorization precedes every workspace lookup", async () => {
	const store = { get: vi.fn(), list: vi.fn(), insert: vi.fn(), update: vi.fn() };
	const client: IWorkspaceClient = {
		prepare: vi.fn(),
		verify: vi.fn(),
		location: vi.fn(),
		head: vi.fn(),
		tree: vi.fn(),
		read: vi.fn(),
		createFile: vi.fn(),
		saveFile: vi.fn(),
		stage: vi.fn(),
		commit: vi.fn(),
	};
	const projects: IProjectService = {
		create: vi.fn(),
		list: vi.fn(),
		get: vi.fn(),
		retry: vi.fn(),
		recover: vi.fn(),
	};
	const differences: IWorkspaceDiffClient = { diff: vi.fn() };
	const service = new WorkspaceService(
		store,
		client,
		projects,
		new AccessService({ owner: "owner", origin: "https://forge.example" }),
		() => "",
		() => new Date(),
		differences,
	);
	await expect(service.get({ username: "outsider" }, "bad")).rejects.toThrow("Access denied");
	expect(store.get).not.toHaveBeenCalled();
});
