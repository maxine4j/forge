import { expect, test } from "vitest";

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
