import { createRequire } from "node:module";
import { isAbsolute } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { TypeScriptBridge } from "./bridge.ts";
import { createMcp } from "./mcp.ts";
import { LanguageProcesses } from "./process.ts";

export async function start(root: string, cwd: string): Promise<() => Promise<void>> {
	if (!isAbsolute(root)) throw new Error("TypeScript bridge requires an absolute worktree root");
	const canonical = await files.realpath(root);
	if (canonical !== (await files.realpath(cwd))) throw new Error("TypeScript bridge root must match process cwd");
	const require = createRequire(import.meta.url);
	const bridge = new TypeScriptBridge(
		canonical,
		files,
		new LanguageProcesses(
			process.execPath,
			require.resolve("typescript-language-server/lib/cli.mjs"),
			files.readFile,
			sleep,
			files.readdir,
		),
		sleep,
	);
	const server = createMcp(bridge);
	const close = async () => {
		await bridge.close();
		await server.close();
	};
	server.server.onclose = () => {
		void bridge.close();
	};
	try {
		await server.connect(new StdioServerTransport());
	} catch (error) {
		await close();
		throw error;
	}
	return close;
}
