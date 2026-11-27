import { PassThrough } from "node:stream";

import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test } from "vitest";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

import { LanguageClient } from "./language-client.ts";

const peer = (
	capabilities: Record<string, unknown> = {
		hoverProvider: true,
		diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false },
	},
) => {
	const input = new PassThrough();
	const output = new PassThrough();
	let stopped = false;
	let crash: () => void = () => {};
	const done = new Promise<void>((resolve) => {
		crash = resolve;
	});
	const server = createMessageConnection(new StreamMessageReader(input), new StreamMessageWriter(output));
	const events: { method: string; params: unknown }[] = [];
	server.onRequest("initialize", (params) => {
		events.push({ method: "initialize", params });
		return { capabilities };
	});
	server.onNotification((method, params) => {
		events.push({ method, params });
		if (method === "initialized")
			void server.sendNotification("$/typescriptVersion", { version: "6.0.3", source: "user-setting" });
	});
	server.onRequest("textDocument/hover", () => ({ contents: "current type" }));
	server.onRequest("textDocument/diagnostic", () => ({ kind: "full", items: [] }));
	server.listen();
	const client = new LanguageClient(
		"/checkout",
		{
			key: "ts",
			installation: "/store/ts",
			packagePath: "/checkout",
			kind: "tsserver",
			entry: "/store/ts/lib/tsserver.js",
			version: "6.0.3",
		},
		{
			spawn: (_runtime, root) => {
				expect(root).toBe("/checkout");
				return {
					input,
					output,
					done,
					stop: async () => {
						stopped = true;
						crash();
						server.dispose();
					},
				};
			},
		},
		sleep,
	);
	return { client, server, events, crash, stopped: () => stopped };
};
test("initializes the checkout root, pins tsserver, syncs document versions and refuses edits", async () => {
	const { client, server, events } = peer();
	try {
		await client.initialize();
		expect(events[0]!.params).toMatchObject({
			rootUri: "file:///checkout",
			workspaceFolders: [{ uri: "file:///checkout" }],
			initializationOptions: {
				disableAutomaticTypingAcquisition: true,
				tsserver: { path: "/store/ts/lib/tsserver.js" },
			},
		});
		const uri = await client.sync("/checkout/index.ts", "let x = 1");
		await client.sync("/checkout/index.ts", "let x = 'a'");
		expect(await client.query("hover", uri, { line: 0, character: 4 })).toEqual({ contents: "current type" });
		expect(events.find((event) => event.method === "textDocument/didOpen")?.params).toMatchObject({
			textDocument: { version: 1, text: "let x = 1" },
		});
		expect(events.find((event) => event.method === "textDocument/didChange")?.params).toMatchObject({
			textDocument: { version: 2 },
			contentChanges: [{ text: "let x = 'a'" }],
		});
		expect(await server.sendRequest("workspace/applyEdit", { edit: {} })).toMatchObject({ applied: false });
		expect(await client.query("diagnostics", uri)).toEqual([]);
		await expect(client.query("references", uri)).rejects.toMatchObject({ code: "unsupported" });
	} finally {
		await client.close();
	}
});
test("timeouts and crashed peers fail without returning successful empty results", async () => {
	const { client, server, crash, stopped } = peer();
	try {
		await client.initialize();
		server.onRequest("textDocument/hover", () => new Promise(() => {}));
		await expect(client.bounded(() => client.query("hover", "file:///checkout/a.ts"), 10)).rejects.toMatchObject({
			code: "timeout",
		});
		crash();
		await Promise.resolve();
		await expect(client.query("diagnostics", "file:///checkout/a.ts")).rejects.toMatchObject({
			code: "unavailable",
		});
	} finally {
		await client.close();
	}
	expect(stopped()).toBe(true);
});
test("rejects stale versioned pushes and clears diagnostics on file changes", async () => {
	const { client, server } = peer({ hoverProvider: true });
	try {
		await client.initialize();
		const uri = await client.sync("/checkout/a.ts", "let x = 1");
		await client.sync("/checkout/a.ts", "let x = 2");
		await server.sendNotification("textDocument/publishDiagnostics", {
			uri,
			version: 1,
			diagnostics: [{ message: "old" }],
		});
		await expect(client.bounded(() => client.query("diagnostics", uri), 10)).rejects.toMatchObject({
			code: "timeout",
		});
		await server.sendNotification("textDocument/publishDiagnostics", { uri, version: 2, diagnostics: [] });
		expect(await client.bounded(() => client.query("diagnostics", uri))).toEqual([]);
		await client.changedFile(uri);
		await expect(client.bounded(() => client.query("diagnostics", uri), 10)).rejects.toMatchObject({
			code: "timeout",
		});
	} finally {
		await client.close();
	}
});

test("legacy diagnostics await all phases instead of an early empty push", async () => {
	const { client, server } = peer({ executeCommandProvider: { commands: ["typescript.tsserverRequest"] } });
	const commands: string[] = [];
	server.onRequest(
		"workspace/executeCommand",
		(params: { command: string; arguments: [string, unknown, unknown] }) => {
			expect(params.command).toBe("typescript.tsserverRequest");
			commands.push(params.arguments[0]);
			return {
				success: true,
				body:
					params.arguments[0] === "semanticDiagnosticsSync"
						? [
								{
									message: "Current error",
									category: "error",
									code: 2322,
									startLocation: { line: 1, offset: 5 },
									endLocation: { line: 1, offset: 6 },
								},
							]
						: [],
			};
		},
	);
	try {
		await client.initialize();
		const uri = await client.sync("/checkout/a.ts", "let x: string = 1");
		await server.sendNotification("textDocument/publishDiagnostics", { uri, diagnostics: [] });
		expect(await client.query("diagnostics", uri)).toEqual([
			expect.objectContaining({
				message: "Current error",
				code: 2322,
				range: { start: { line: 0, character: 4 }, end: { line: 0, character: 5 } },
			}),
		]);
		expect(commands).toEqual(["syntacticDiagnosticsSync", "semanticDiagnosticsSync", "suggestionDiagnosticsSync"]);
	} finally {
		await client.close();
	}
});
