import { expect, test, vi } from "vitest";

import { WorkspaceMergeClient } from "./workspace-merge-client.ts";

test("fast-forward checks ancestry and clean files, then atomically updates main with its expected SHA", async () => {
	const main = "a".repeat(40),
		head = "b".repeat(40);
	const run = vi.fn(async (args: string[]) => {
		if (args.includes("symbolic-ref")) return "refs/heads/forge/workspace/test";
		if (args.includes("status")) return "";
		if (args.includes("merge-base")) return main;
		if (args.includes("rev-parse")) return args.includes("refs/heads/main") ? main : head;
		return "";
	});
	const workspaces = {
		get: vi.fn(),
		tree: vi.fn(),
		create: vi.fn(),
		resolve: vi.fn(async () => ({
			path: "/data/worktrees/test",
			workspace: {
				id: "test",
				projectId: "project",
				name: "Task",
				branch: "forge/workspace/test",
				status: "ready" as const,
				createdAt: "2026-11-03T00:00:00.000Z",
				baseSha: main,
			},
		})),
	};
	const client = new WorkspaceMergeClient(workspaces, { run });
	expect(await client.merge({ username: "owner" }, "test", head)).toBe("merged");
	expect(run).toHaveBeenCalledWith(
		["-C", "/data/worktrees/test", "update-ref", "--stdin"],
		expect.stringContaining(
			`verify refs/heads/forge/workspace/test ${head}\nupdate refs/heads/main ${head} ${main}`,
		),
	);
	run.mockImplementation(async (args) => (args.includes("status") ? " M file.ts" : head));
	await expect(client.merge({ username: "owner" }, "test", head)).rejects.toThrow("ticket-conflict");
	run.mockImplementation(async (args) => {
		if (args.includes("symbolic-ref")) return "refs/heads/forge/workspace/test";
		if (args.includes("status")) return "";
		if (args.includes("merge-base")) return "c".repeat(40);
		return args.includes("refs/heads/main") ? main : head;
	});
	expect(await client.merge({ username: "owner" }, "test", head)).toBe("rebase");
	expect(run.mock.calls.filter(([args]) => args.includes("update-ref"))).toHaveLength(1);

	// Another writer advanced main to an ancestor of the candidate during the CAS.
	const advanced = "c".repeat(40);
	let current = main;
	run.mockImplementation(async (args) => {
		if (args.includes("symbolic-ref")) return "refs/heads/forge/workspace/test";
		if (args.includes("status")) return "";
		if (args.includes("update-ref") && current === main) {
			current = advanced;
			throw new Error("Main advanced");
		}
		if (args.includes("update-ref")) return "";
		return args.includes("refs/heads/main") || args.includes("merge-base") ? current : head;
	});
	expect(await client.merge({ username: "owner" }, "test", head)).toBe("merged");
	expect(run).toHaveBeenLastCalledWith(
		["-C", "/data/worktrees/test", "update-ref", "--stdin"],
		expect.stringContaining(`update refs/heads/main ${head} ${advanced}`),
	);
});

test("rejects a branch changed after owner approval and verifies committed completion", async () => {
	const run = vi.fn(async (args: string[]) => {
		if (args.includes("symbolic-ref")) return "refs/heads/forge/workspace/id";
		if (args.includes("status")) return "";
		return "b".repeat(40);
	});
	const workspaces = {
		get: vi.fn(),
		tree: vi.fn(),
		create: vi.fn(),
		resolve: vi.fn(async () => ({
			path: "/work",
			workspace: {
				id: "id",
				projectId: "project",
				name: "Task",
				branch: "forge/workspace/id",
				status: "ready" as const,
				createdAt: "2026-11-03T00:00:00.000Z",
			},
		})),
	};
	const client = new WorkspaceMergeClient(workspaces, { run });
	await expect(client.merge({ username: "owner" }, "id", "c".repeat(40))).rejects.toThrow("ticket-conflict");
	expect(await client.candidate({ username: "owner" }, "id")).toBe("b".repeat(40));
	await client.verify({ username: "owner" }, "id", "b".repeat(40));
	run.mockImplementation(async (args) => (args.includes("status") ? "?? uncommitted" : "b".repeat(40)));
	await expect(client.verify({ username: "owner" }, "id", "b".repeat(40))).rejects.toThrow("ticket-conflict");
});
