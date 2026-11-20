import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import { start } from "./start.ts";

test("startup rejects relative roots and a different process checkout before starting MCP", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-lsp-start-"));
	try {
		await expect(start("relative", root)).rejects.toThrow("absolute worktree root");
		await files.mkdir(join(root, "other"));
		await expect(start(root, join(root, "other"))).rejects.toThrow("root must match process cwd");
	} finally {
		await files.rm(root, { recursive: true, force: true });
	}
});
