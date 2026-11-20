import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { type TypeScriptBridge, toolInput, tools } from "./bridge.ts";
import { ToolError } from "./runtime-resolution.ts";

export function createMcp(bridge: TypeScriptBridge): McpServer {
	const server = new McpServer({ name: "forge_typescript", version: "1.0.0" });
	for (const tool of tools)
		server.registerTool(
			tool,
			{
				description: `Read-only TypeScript ${tool}. Reads current disk contents. Positions are zero-based UTF-16; locations are worktree-relative or explicitly external.`,
				inputSchema: toolInput,
				annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
			},
			async (input) => {
				try {
					const result = await bridge.call(tool, input);
					return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
				} catch (error) {
					const result = {
						status: error instanceof ToolError ? error.code : "unavailable",
						message:
							error instanceof ToolError
								? error.message.slice(0, 1000)
								: "TypeScript tooling unavailable; verify local dependencies and retry.",
					};
					return {
						isError: true,
						content: [{ type: "text", text: JSON.stringify(result) }],
						structuredContent: result,
					};
				}
			},
		);
	return server;
}
