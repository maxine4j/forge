import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, it, vi } from "vitest";

import { TerminalProcess } from "./terminal-process.ts";

it("fails unavailable on unsupported native platforms without accessing process inventory", async () => {
	const identify = vi.fn();
	const adapter = new TerminalProcess("/bin", sleep, { identify, groups: vi.fn() }, "darwin");
	await expect(adapter.spawn({ path: "/verified", cols: 80, rows: 24, onOutput: () => {} })).rejects.toMatchObject({
		code: "terminal-unavailable",
	});
	expect(identify).not.toHaveBeenCalled();
});
