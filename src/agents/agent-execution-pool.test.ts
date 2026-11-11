import { expect, test, vi } from "vitest";

import { AgentExecutionPool } from "./agent-execution-pool.ts";

test("limits all active work to three, retains uncertain slots and releases completed work", () => {
	const pool = new AgentExecutionPool();
	for (const id of ["planning", "implementation", "review"]) pool.claim(id);
	expect(() => pool.claim("rebase")).toThrow("agent-capacity");
	pool.claim("planning");
	pool.observe("planning", "uncertain");
	expect(() => pool.claim("rebase")).toThrow("agent-capacity");
	pool.observe("review", "completed");
	pool.claim("rebase");
	expect(pool.available()).toBe(false);
	pool.observe("rebase", "waiting");
	expect(pool.available()).toBe(false);
	pool.observe("rebase", "interrupted");
	expect(pool.available()).toBe(true);
});

test("wakes the scheduler only when an occupied slot is released", () => {
	const wake = vi.fn();
	const pool = new AgentExecutionPool(wake);
	pool.claim("planner");
	pool.observe("planner", "waiting");
	pool.observe("other", "completed");
	expect(wake).not.toHaveBeenCalled();
	pool.observe("planner", "completed");
	pool.observe("planner", "completed");
	expect(wake).toHaveBeenCalledOnce();
});

test("changing the limit preserves active slots and wakes scheduling when capacity opens", () => {
	const wake = vi.fn();
	const pool = new AgentExecutionPool(wake);
	pool.claim("ticket");
	pool.claim("chat");
	pool.setLimit(1);
	expect(() => pool.claim("next")).toThrow("agent-capacity");
	pool.observe("ticket", "completed");
	expect(() => pool.claim("next")).toThrow("agent-capacity");
	wake.mockClear();
	pool.setLimit(2);
	expect(wake).toHaveBeenCalledOnce();
	pool.claim("next");
	expect(pool.available()).toBe(false);
});
