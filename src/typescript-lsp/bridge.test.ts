import { PassThrough } from "node:stream";

import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test } from "vitest";
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

import { TypeScriptBridge } from "./bridge.ts";

const setup = () => {
	const data = new Map([
		["/checkout/package.json", "{}"],
		["/checkout/index.ts", "export const value = 1;"],
		["/checkout/node_modules/typescript/package.json", '{"version":"7.0.2","bin":{"tsc":"bin/tsc"}}'],
	]);
	const watchers = new Set<(path?: string) => void>();
	let starts = 0;
	let stops = 0;
	let idle = () => {};
	let hover: () => unknown = () => ({ contents: "number" });
	const events: string[] = [];
	const bridge = new TypeScriptBridge(
		"/checkout",
		{
			readFile: async (path) => data.get(path),
			realpath: async (path) => path,
			stat: async () => ({ size: 1, isFile: () => true }),
			watch: (_path, changed) => {
				watchers.add(changed);
				return () => {
					watchers.delete(changed);
				};
			},
		},
		{
			spawn: (_runtime, root) => {
				expect(root).toBe("/checkout");
				starts++;
				const input = new PassThrough();
				const output = new PassThrough();
				const server = createMessageConnection(new StreamMessageReader(input), new StreamMessageWriter(output));
				server.onRequest("initialize", async (params) => {
					expect(params).toMatchObject({
						rootUri: "file:///checkout",
						workspaceFolders: [{ uri: "file:///checkout" }],
					});
					await sleep(10);
					events.push("initialize");
					return { capabilities: { hoverProvider: true, referencesProvider: true } };
				});
				server.onNotification((method) => {
					events.push(method);
				});
				server.onRequest("textDocument/hover", () => hover());
				server.onRequest("textDocument/references", () =>
					Array.from({ length: 120 }, () => ({
						uri: "file:///dependency/index.d.ts",
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
					})),
				);
				server.listen();
				let exited = false;
				let done = () => {};
				const completion = new Promise<void>((resolve) => {
					done = resolve;
				});
				return {
					input,
					output,
					done: completion,
					stop: async () => {
						if (exited) return;
						exited = true;
						stops++;
						server.dispose();
						done();
					},
				};
			},
		},
		async (delay, signal) => {
			if (delay !== 60000) return sleep(delay, signal);
			await new Promise<void>((resolve) => {
				idle = resolve;
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});
		},
	);
	return {
		bridge,
		data,
		events,
		counts: () => ({ starts, stops }),
		idle: () => idle(),
		change: () => {
			for (const changed of watchers) changed("index.ts");
		},
		hover: (fn: () => unknown) => {
			hover = fn;
		},
	};
};
const position = { path: "index.ts", line: 0, character: 14 };
test("concurrent calls serialize initialization/synchronization and idle cleanup permits recreation", async () => {
	const fixture = setup();
	try {
		await Promise.all(Array.from({ length: 4 }, () => fixture.bridge.call("hover", position)));
		expect(fixture.counts()).toEqual({ starts: 1, stops: 0 });
		expect(fixture.events.filter((event) => event === "initialize")).toHaveLength(1);
		expect(fixture.events.filter((event) => event === "textDocument/didOpen")).toHaveLength(1);
		fixture.idle();
		await sleep(10);
		expect(fixture.counts().stops).toBe(1);
		await fixture.bridge.call("hover", position);
		expect(fixture.counts().starts).toBe(2);
	} finally {
		await fixture.bridge.close();
	}
});
test("changes during a query invalidate results and the next call recreates the server", async () => {
	const fixture = setup();
	let release = () => {};
	let queried = () => {};
	const ready = new Promise<void>((resolve) => {
		queried = resolve;
	});
	fixture.hover(
		() =>
			new Promise((resolve) => {
				release = () => resolve({ contents: "old" });
				queried();
			}),
	);
	try {
		const query = fixture.bridge.call("hover", position);
		await ready;
		fixture.data.set("/checkout/index.ts", "export const value = 'new';");
		fixture.change();
		release();
		await expect(query).rejects.toMatchObject({ code: "changed" });
		fixture.hover(() => ({ contents: "string" }));
		expect(JSON.stringify(await fixture.bridge.call("hover", position))).toContain("string");
		expect(fixture.counts().starts).toBe(2);
	} finally {
		await fixture.bridge.close();
	}
});
test("bounds structured results and labels dependency locations as external", async () => {
	const fixture = setup();
	try {
		const result = await fixture.bridge.call("references", position);
		expect(result["truncated"]).toBe(true);
		expect(result["result"]).toHaveLength(100);
		expect((result["result"] as unknown[])[0]).toMatchObject({ path: "/dependency/index.d.ts", external: true });
	} finally {
		await fixture.bridge.close();
	}
});
