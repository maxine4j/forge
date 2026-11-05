import { expect, test } from "vitest";

import { GitDiffClient } from "../repositories/git-diff-client.ts";
import type { IGitBinaryTransport } from "../repositories/git-transport.ts";
import { PullRequestClient } from "./pull-request-client.ts";

const id = "11111111-1111-4111-8111-111111111111";
const head = "b".repeat(40);
const base = "a".repeat(40);
const setup = () => {
	const calls: string[][] = [];
	const state = {
		branch: `refs/heads/forge/workspace/${id}`,
		heads: 0,
		moving: false,
		large: false,
		namesFail: false,
	};
	const git: IGitBinaryTransport = {
		run: async (args) => {
			calls.push(args);
			if (args.includes("symbolic-ref")) return state.branch;
			if (args.includes("merge-base")) return base;
			if (args.includes("rev-parse")) {
				if (args.some((arg) => arg.includes("^{tree}")))
					return args.some((arg) => arg.includes(head)) ? head : base;
				if (args.some((arg) => arg.includes("refs/heads/main"))) return base;
				return ++state.heads > 1 && state.moving ? "c".repeat(40) : head;
			}
			if (args.includes("--name-only")) {
				if (state.namesFail) throw new Error("output bound");
				return state.large
					? Array.from({ length: 105 }, (_, n) => `file-${n}\0`).join("")
					: "text\0binary\0invalid-utf8\0../secret\0";
			}
			if (args.includes("--numstat")) return args.at(-1) === "binary" ? "-\t-\tbinary" : "1\t0\ttext";
			throw new Error("Unexpected Git command");
		},
		runBytes: async (args) => {
			calls.push(args);
			return args.at(-1) === "invalid-utf8"
				? Buffer.from([255])
				: Buffer.from(state.large ? "line\n".repeat(1500) : "+work\n");
		},
	};
	const client = new PullRequestClient(
		{
			resolve: async () => ({
				path: "/private/owned",
				workspace: {
					id,
					projectId: id,
					name: "Work",
					branch: `forge/workspace/${id}`,
					status: "ready",
					createdAt: "2026-01-01T00:00:00Z",
					head,
				},
			}),
		},
		git,
		new GitDiffClient(git),
	);
	return { client, state, calls };
};

test("committed diff uses immutable SHAs, bounds paths, labels binary, and never invokes Git writes", async () => {
	const f = setup();
	const result = await f.client.diff({ username: "owner" }, id);
	expect(result.revision).toEqual({ head, baseSha: base, mergeBase: base });
	expect(result.diff).toMatchObject({
		files: [
			{ path: "text", binary: false },
			{ path: "binary", binary: true },
			{ path: "invalid-utf8", binary: true },
		],
		patch: "+work\n",
		truncated: true,
	});
	expect((await f.client.inspect({ username: "owner" }, id)).hasChanges).toBe(true);
	for (const args of f.calls.filter((args) => args.includes("diff"))) {
		expect(args).toContain(base);
		expect(args).toContain(head);
		expect(args).toContain("--no-ext-diff");
		expect(args).not.toContain("--cached");
	}
	expect(
		f.calls.every((args) =>
			["diff", "rev-parse", "merge-base", "symbolic-ref"].some((command) => args.includes(command)),
		),
	).toBe(true);
});

test("main checkout and concurrent branch movement fail closed with a fixed caller failure", async () => {
	const f = setup();
	f.state.branch = "refs/heads/main";
	await expect(f.client.inspect({ username: "owner" }, id)).rejects.toMatchObject({
		code: "pull-request-unavailable",
		message: "pull-request-unavailable",
	});
	const moving = setup();
	moving.state.moving = true;
	await expect(moving.client.inspect({ username: "owner" }, id)).rejects.toMatchObject({
		code: "pull-request-unavailable",
	});
});

test("revision inspection only observes refs and trees, without producing patches", async () => {
	const f = setup();
	expect((await f.client.inspect({ username: "owner" }, id)).hasChanges).toBe(true);
	expect(f.calls.some((args) => args.includes("diff"))).toBe(false);
});

test("large patches and file lists are explicitly truncated, including bounded Git failures", async () => {
	const f = setup();
	f.state.large = true;
	const { diff } = await f.client.diff({ username: "owner" }, id);
	expect(diff.files).toHaveLength(100);
	expect(diff.truncated).toBe(true);
	expect(diff.patch.split("\n").length).toBeLessThanOrEqual(1000);
	expect(Buffer.byteLength(diff.patch)).toBeLessThanOrEqual(262144);
	f.state.namesFail = true;
	expect((await f.client.diff({ username: "owner" }, id)).diff).toEqual({ files: [], patch: "", truncated: true });
});
