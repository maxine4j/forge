import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test, vi } from "vitest";

import type { ICodexAgentConnection } from "../accounts/codex-connection.ts";
import { releaseWorktree } from "./worktree-release.ts";

test("awaits all associated thread closures and leaves unrelated agents and history intact", async () => {
	let notify = (_method: string, _params: unknown) => {};
	const calls: string[] = [];
	const request = vi.fn(async (method: string, params: { threadId?: string }) => {
		calls.push(`${method}:${params.threadId ?? ""}`);
		if (method === "thread/loaded/list")
			return { data: ["planner", "implementation", "unrelated"], nextCursor: null };
		if (method === "thread/read")
			return {
				thread: { cwd: params.threadId === "unrelated" ? "/other" : "/checkout", status: { type: "idle" } },
			};
		if (method === "thread/unsubscribe") {
			queueMicrotask(() => notify("thread/closed", { threadId: params.threadId }));
			return { status: "unsubscribed" };
		}
		throw new Error(method);
	});
	const unsubscribe = vi.fn();
	const connection = {
		initialize: async () => {},
		request,
		subscribe: (listener: typeof notify) => {
			notify = listener;
			return unsubscribe;
		},
	} as unknown as ICodexAgentConnection;
	await releaseWorktree(connection, "/checkout", sleep);
	expect(calls.filter((call) => call.startsWith("thread/unsubscribe"))).toEqual([
		"thread/unsubscribe:planner",
		"thread/unsubscribe:implementation",
	]);
	expect(unsubscribe).toHaveBeenCalledOnce();
});
test("unsettled associated executions fail release", async () => {
	const connection = {
		initialize: async () => {},
		subscribe: () => () => {},
		request: async (method: string) =>
			method === "thread/loaded/list"
				? { data: ["active"] }
				: { thread: { cwd: "/checkout", status: { type: "active" } } },
	} as unknown as ICodexAgentConnection;
	await expect(releaseWorktree(connection, "/checkout", sleep)).rejects.toThrow("unsettled");
});
