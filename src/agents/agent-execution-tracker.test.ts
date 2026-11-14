import { expect, test, vi } from "vitest";

import { AgentExecutionTracker } from "./agent-execution-tracker.ts";

test("tracks unlimited active and uncertain executions until settlement", () => {
	const tracker = new AgentExecutionTracker();
	for (const id of ["planning", "implementation", "review", "rebase", "chat"]) tracker.claim(id);
	tracker.claim("planning");
	tracker.observe("planning", "uncertain");
	tracker.observe("review", "waiting");
	expect(tracker.activeIds()).toHaveLength(5);
	tracker.observe("rebase", "interrupted");
	tracker.observe("chat", "completed");
	tracker.observe("implementation", "failed");
	expect(tracker.activeIds()).toEqual(["planning", "review"]);
});

test("wakes scheduling only when a tracked execution settles", () => {
	const wake = vi.fn();
	const tracker = new AgentExecutionTracker(wake);
	tracker.claim("planner");
	tracker.observe("planner", "waiting");
	tracker.observe("other", "completed");
	expect(wake).not.toHaveBeenCalled();
	tracker.observe("planner", "completed");
	tracker.observe("planner", "completed");
	expect(wake).toHaveBeenCalledOnce();
});
