import type { ISleep } from "@forge/backend-infrastructure/sleep";
import { z } from "zod";

import type { ICodexAgentConnection } from "../accounts/codex-connection.ts";

/** Retains persistent rollouts. Completion means runtime children have been closed. */
export async function releaseWorktree(connection: ICodexAgentConnection, path: string, sleep: ISleep): Promise<void> {
	await connection.initialize();
	const closed = new Set<string>();
	const wakes = new Set<() => void>();
	let failure: Error | undefined;
	const assertOpen = () => {
		if (failure) throw failure;
	};
	const unsubscribe = connection.subscribe((method, params) => {
		if (method === "connection/lost") {
			failure = new Error("Codex disconnected while releasing a worktree; retain it for retry");
			for (const wake of wakes) wake();
		}
		const parsed = z.object({ threadId: z.string() }).safeParse(params);
		if (method === "thread/closed" && parsed.success) {
			closed.add(parsed.data.threadId);
			for (const wake of wakes) wake();
		}
	});
	const timer = new AbortController();
	try {
		await Promise.race([
			(async () => {
				let cursor: string | undefined;
				const ids = new Set<string>();
				let complete = false;
				// Snapshot pagination before unloading changes the loaded-thread collection.
				for (let pages = 0; pages < 100; pages++) {
					assertOpen();
					const page = z
						.object({ data: z.array(z.string()).max(100), nextCursor: z.string().nullish() })
						.parse(
							await connection.request("thread/loaded/list", {
								limit: 100,
								...(cursor ? { cursor } : {}),
							}),
						);
					for (const id of page.data) ids.add(id);
					if (!page.nextCursor) {
						complete = true;
						break;
					}
					cursor = page.nextCursor;
				}
				if (!complete) throw new Error("Too many loaded Codex threads to release safely");
				for (const threadId of ids) {
					assertOpen();
					const { thread } = z
						.object({ thread: z.object({ cwd: z.string(), status: z.object({ type: z.string() }) }) })
						.parse(await connection.request("thread/read", { threadId, includeTurns: false }));
					if (thread.cwd !== path) continue;
					if (thread.status.type !== "idle") throw new Error("Worktree still has an unsettled Codex thread");
					assertOpen();
					const result = z
						.object({ status: z.enum(["notLoaded", "notSubscribed", "unsubscribed"]) })
						.parse(await connection.request("thread/unsubscribe", { threadId }));
					if (result.status !== "notLoaded" && !closed.has(threadId))
						await new Promise<void>((resolve) => {
							const wake = () => {
								if (closed.has(threadId) || failure) {
									wakes.delete(wake);
									resolve();
								}
							};
							wakes.add(wake);
							wake();
						});
					assertOpen();
				}
			})(),
			sleep(30000, timer.signal).then(() => {
				failure = new Error("Timed out closing worktree Codex threads; retain worktree for retry");
				for (const wake of wakes) wake();
				throw failure;
			}),
		]);
	} finally {
		timer.abort();
		unsubscribe();
		wakes.clear();
	}
}
