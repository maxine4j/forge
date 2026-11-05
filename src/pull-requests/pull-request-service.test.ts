import { expect, test } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import type { IPullRequestClient } from "./pull-request-client.ts";
import { PullRequestService } from "./pull-request-service.ts";
import type { IPullRequestStore } from "./pull-request-store.ts";
import type { PullRequestRecord, DiscussionRecord } from "./types.ts";

const owner = { username: "owner" };
const projectId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const setup = () => {
	const records = new Map<string, PullRequestRecord>();
	const discussions: DiscussionRecord[] = [];
	const revision = { baseSha: "a".repeat(40), head: "b".repeat(40), mergeBase: "a".repeat(40) };
	const reads = { inspect: 0, discussion: 0 };
	let unavailable = false;
	const client: IPullRequestClient = {
		inspect: async () => {
			reads.inspect++;
			if (unavailable) throw new Error("private path");
			return {
				projectId,
				workspaceId,
				branch: `forge/workspace/${workspaceId}`,
				revision: { ...revision },
				hasChanges: true,
			};
		},
		diff: async () => ({
			comparison: "merge-base(main, workspace)..workspace (committed)",
			revision: { ...revision },
			diff: { files: [{ path: "file", binary: false }], patch: "+work", truncated: false },
		}),
	};
	const store: IPullRequestStore = {
		insert: async (record) => {
			records.set(record.id, record);
		},
		get: async (id) => records.get(id),
		list: async () => [...records.values()],
		update: async (record) => {
			records.set(record.id, record);
		},
		append: async (record) => {
			discussions.push(record);
		},
		discussion: async (id) => {
			reads.discussion++;
			return discussions.filter((record) => record.pullRequestId === id);
		},
	};
	let sequence = 0;
	const service = new PullRequestService(
		store,
		client,
		new AccessService({ owner: "owner", origin: "https://forge.example" }),
		() => `33333333-3333-4333-8333-${String(++sequence).padStart(12, "0")}`,
		() => new Date("2026-01-01T00:00:00Z"),
	);
	return {
		service,
		store,
		reads,
		revision,
		records,
		discussions,
		unavailable: () => {
			unavailable = true;
		},
	};
};

test("approvals bind exact main and source revisions, become stale, and discussion survives source loss", async () => {
	const f = setup();
	const expected = { expectedHead: f.revision.head, expectedBase: f.revision.baseSha };
	const pr = await f.service.create(owner, projectId, { workspaceId, title: "Review", body: "", ...expected });
	expect(pr.approval).toBe("none");
	expect((await f.service.review(owner, pr.id, { decision: "approve", body: "good", ...expected })).approval).toBe(
		"approved",
	);
	f.revision.baseSha = "c".repeat(40);
	expect((await f.service.get(owner, pr.id)).approval).toBe("stale");
	await expect(f.service.comment(owner, pr.id, { body: "stale", ...expected })).rejects.toMatchObject({
		code: "revision-conflict",
	});
	f.unavailable();
	const lost = await f.service.get(owner, pr.id);
	expect(lost.approval).toBe("unavailable");
	expect(lost.discussion).toHaveLength(1);
});

test("owner guards, immutable source, close/reopen, changes requested and malformed mutations", async () => {
	const f = setup();
	const expected = { expectedHead: f.revision.head, expectedBase: f.revision.baseSha };
	await expect(
		f.service.create({ username: "other" }, projectId, { workspaceId, title: "Review", body: "", ...expected }),
	).rejects.toThrow("Access denied");
	const pr = await f.service.create(owner, projectId, { workspaceId, title: "Review", body: "", ...expected });
	expect(
		(await f.service.review(owner, pr.id, { decision: "request-changes", body: "fix", ...expected })).approval,
	).toBe("requested-changes");
	expect((await f.service.update(owner, pr.id, { status: "closed", ...expected })).status).toBe("closed");
	await expect(f.service.review(owner, pr.id, { decision: "approve", body: "", ...expected })).rejects.toMatchObject({
		code: "pull-request-closed",
	});
	expect((await f.service.update(owner, pr.id, { status: "open", title: "New", ...expected })).title).toBe("New");
	expect((await f.service.comment(owner, pr.id, { body: "discussion", ...expected })).discussion).toHaveLength(2);
	await expect(f.service.update(owner, pr.id, { ...expected, title: "" })).rejects.toMatchObject({
		code: "invalid-request",
	});
});

test("list is metadata only and never observes Git or loads discussion", async () => {
	const f = setup();
	const pr = await f.service.create(owner, projectId, {
		workspaceId,
		title: "Review",
		body: "",
		expectedHead: f.revision.head,
		expectedBase: f.revision.baseSha,
	});
	f.unavailable();
	const before = { ...f.reads };
	const list = await f.service.list(owner, projectId);
	expect(f.reads).toEqual(before);
	expect(list).toHaveLength(1);
	expect(list.at(0)).not.toHaveProperty("approval");
	expect(list.at(0)).not.toHaveProperty("discussion");
	expect(list.at(0)).toMatchObject({ id: pr.id, title: "Review" });
});

test("serialized workflows reject excess queued work rather than growing without bound", async () => {
	const f = setup();
	let release = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	f.store.list = async () => {
		await gate;
		return [];
	};
	const accepted = Array.from({ length: 100 }, () => f.service.list(owner, projectId));
	try {
		await expect(f.service.list(owner, projectId)).rejects.toMatchObject({ code: "pull-request-unavailable" });
	} finally {
		release();
		await Promise.all(accepted);
	}
});
