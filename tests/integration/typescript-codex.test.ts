import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test, vi } from "vitest";

import { AccountProcess } from "../../src/accounts/account-process.ts";
import { CodexConnection } from "../../src/accounts/codex-connection.ts";
import { CodexAgentClient } from "../../src/codex/codex-agent-client.ts";
import { releaseWorktree } from "../../src/codex/worktree-release.ts";

test("pinned Codex scopes MCP by checkout across resume/restart and immediately closes unsubscribed threads", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-typescript-codex-"));
	const require = createRequire(import.meta.url);
	const inference = createServer((request, response) => {
		request.resume();
		request.on("end", () => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			for (const event of [
				{ type: "response.created", response: { id: "fixture" } },
				{
					type: "response.output_item.done",
					output_index: 0,
					item: {
						id: "msg",
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "Fixture history" }],
					},
				},
				{
					type: "response.completed",
					response: {
						id: "fixture",
						status: "completed",
						output: [],
						usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
					},
				},
			])
				response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			response.end();
		});
	});
	await new Promise<void>((resolve) => inference.listen(0, "127.0.0.1", resolve));
	const address = inference.address();
	if (!address || typeof address === "string") throw new Error("Missing inference listener");
	const provider = { kind: "ollama", endpoint: `http://127.0.0.1:${address.port}/v1`, model: "fixture" } as const;
	const connection = new CodexConnection(
		new AccountProcess(
			{
				dataDirectory: root,
				codexExecutable: resolve("node_modules/.bin/codex"),
				githubExecutable: "gh",
				path: process.env["PATH"] ?? "",
			},
			sleep,
		),
		sleep,
	);
	const client = new CodexAgentClient(connection, files.realpath, randomUUID, undefined, {
		command: process.execPath,
		bridge: resolve("dist/typescript-lsp/main.js"),
	});
	try {
		const paths: string[] = [];
		for (const [name, type, value] of [
			["one", "string", "'one'"],
			["two", "number", "42"],
		]) {
			const checkout = join(root, name!);
			paths.push(checkout);
			await files.mkdir(join(checkout, "node_modules"), { recursive: true });
			await files.symlink(
				dirname(require.resolve("typescript/package.json")),
				join(checkout, "node_modules/typescript"),
			);
			await files.writeFile(join(checkout, "package.json"), "{}");
			await files.writeFile(
				join(checkout, "tsconfig.json"),
				'{"compilerOptions":{"strict":true},"include":["*.ts"]}',
			);
			await files.writeFile(
				join(checkout, "index.ts"),
				`export const value: ${type} = ${value};\nconsole.log(value);\n`,
			);
		}
		const ids = await Promise.all(paths.map((path) => client.start(path, provider)));
		await Promise.all(ids.map((id, index) => client.send(id, paths[index]!, "Record fixture history")));
		await vi.waitFor(
			() => {
				for (const id of ids) expect(client.read(id).status).toBe("completed");
			},
			{ timeout: 10000 },
		);
		const query = (id: string, tool = "hover") =>
			connection.request("mcpServer/tool/call", {
				threadId: id,
				server: "forge_typescript",
				tool,
				arguments: {
					path: "index.ts",
					...(tool === "hover" || tool === "references" ? { line: 0, character: 14 } : {}),
				},
			});
		const check = async () => {
			expect(JSON.stringify(await query(ids[0]!))).toContain("string");
			expect(JSON.stringify(await query(ids[1]!))).toContain("number");
			expect(JSON.stringify(await query(ids[0]!, "references"))).toContain("index.ts");
			expect(JSON.stringify(await query(ids[1]!, "diagnostics"))).toContain('"status":"ok"');
		};
		await check();
		await client.resume(ids[0]!, paths[0]!, provider);
		await check();
		await connection.restart();
		await Promise.all(ids.map((id, index) => client.resume(id, paths[index]!, provider)));
		await check();
		await releaseWorktree(connection, paths[0]!, sleep);
		const loaded = (await connection.request("thread/loaded/list", { limit: 100 })) as { data: string[] };
		expect(loaded.data).not.toContain(ids[0]);
		expect(loaded.data).toContain(ids[1]);
		expect(JSON.stringify(await query(ids[1]!))).toContain("number");
		// Unloading preserves the rollout and allows an explicit resume.
		expect((await client.resume(ids[0]!, paths[0]!, provider)).items).toContainEqual(
			expect.objectContaining({ text: "Fixture history" }),
		);
		expect(JSON.stringify(await query(ids[0]!))).toContain("string");
	} finally {
		await connection.close();
		inference.closeAllConnections();
		await new Promise<void>((resolve) => inference.close(() => resolve()));
		await files.rm(root, { recursive: true, force: true });
	}
}, 120000);
