import { expect, test, vi } from "vitest";

import type { ITerminalService } from "../terminal/terminal-service.ts";
import { AbandonedWorkspaceCleanup } from "./abandoned-workspace-cleanup.ts";
import { WorkspaceError } from "./errors.ts";

test("terminal settlement precedes discarding work and a failed close preserves files for retry", async () => {
	const actor = { username: "owner" };
	const status = vi.fn<ITerminalService["status"]>(async () => ({
		id: "terminal",
		workspaceId: "workspace",
		status: "running",
		createdAt: "2026-11-03T00:00:00.000Z",
		cols: 80,
		rows: 24,
	}));
	const close = vi.fn<ITerminalService["close"]>();
	const discard = vi.fn(async () => {});
	const cleanup = new AbandonedWorkspaceCleanup({ status, close }, { cleanupAbandoned: discard });
	close.mockRejectedValueOnce(new Error("Still running"));
	await expect(cleanup.cleanupAbandoned(actor, "workspace")).rejects.toThrow("Still running");
	expect(discard).not.toHaveBeenCalled();
	close.mockImplementationOnce(async () => {
		expect(discard).not.toHaveBeenCalled();
		return { ...(await status(actor, "workspace"))!, status: "closed" };
	});
	await cleanup.cleanupAbandoned(actor, "workspace");
	expect(discard).toHaveBeenCalledWith(actor, "workspace");
	status.mockResolvedValue(undefined);
	await cleanup.cleanupAbandoned(actor, "workspace");
	expect(close).toHaveBeenCalledTimes(2);
	status.mockRejectedValueOnce(new WorkspaceError("workspace-not-found"));
	await cleanup.cleanupAbandoned(actor, "workspace");
	expect(discard).toHaveBeenCalledTimes(3);
});
