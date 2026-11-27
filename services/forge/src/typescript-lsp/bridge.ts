import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { ISleep } from "@forge/backend-infrastructure/sleep";
import { z } from "zod";

import { LanguageClient } from "./language-client.ts";
import type { ILanguageProcesses } from "./process.ts";
import { inside, RuntimeResolver, ToolError, type LspFiles } from "./runtime-resolution.ts";

export const tools = [
	"diagnostics",
	"hover",
	"definition",
	"references",
	"document_symbols",
	"workspace_symbols",
] as const;
export const toolInput = z
	.object({
		path: z
			.string()
			.min(1)
			.max(4096)
			.describe("Worktree-relative TS/TSX/JS/JSX file; also supplies package context for workspace_symbols."),
		line: z.int().min(0).optional().describe("Zero-based line."),
		character: z.int().min(0).optional().describe("Zero-based UTF-16 code-unit offset within the line."),
		query: z.string().max(256).optional(),
	})
	.strict();
interface Slot {
	tail: Promise<unknown>;
	client?: LanguageClient;
	generation: number;
	idle?: AbortController;
	unwatch?: () => void;
}
export class TypeScriptBridge {
	private readonly resolver: RuntimeResolver;
	private readonly slots = new Map<string, Slot>();
	private generation = 0;
	private closed = false;
	private readonly unwatch: () => void;
	constructor(
		private readonly root: string,
		private readonly files: LspFiles,
		private readonly processes: ILanguageProcesses,
		private readonly sleep: ISleep,
	) {
		this.resolver = new RuntimeResolver(root, files);
		this.unwatch = files.watch(root, (path) => {
			if (path?.split("/").includes(".git")) return;
			this.invalidate(path ? pathToFileURL(join(root, path)).href : undefined);
		});
	}
	private invalidate(uri?: string): void {
		this.generation++;
		for (const slot of this.slots.values()) void slot.client?.changedFile(uri).catch(() => {});
	}
	async call(name: string, raw: unknown): Promise<Record<string, unknown>> {
		const deadline = new AbortController();
		const timer = new AbortController();
		try {
			return await Promise.race([
				this.execute(name, raw, deadline.signal),
				this.sleep(30000, timer.signal).then(() => {
					deadline.abort();
					throw new ToolError("timeout", "TypeScript tool exceeded 30 seconds, including queue time; retry.");
				}),
			]);
		} finally {
			timer.abort();
		}
	}
	private async execute(name: string, raw: unknown, deadline: AbortSignal): Promise<Record<string, unknown>> {
		if (!tools.includes(name as (typeof tools)[number]))
			throw new ToolError("unsupported", "Unknown TypeScript tool.");
		const parsed = toolInput.safeParse(raw);
		if (!parsed.success)
			throw new ToolError("invalid_input", "Expected path and optional zero-based line, character and query.");
		const input = parsed.data;
		const positioned = ["hover", "definition", "references"].includes(name);
		if (positioned && (input.line === undefined || input.character === undefined))
			throw new ToolError("invalid_input", "Position tools require zero-based line and UTF-16 character.");
		const file = await this.resolver.file(input.path);
		const runtime = await this.resolver.resolve(file);
		if (this.closed) throw new ToolError("unavailable", "Worktree bridge is closing.");
		let slot = this.slots.get(runtime.key);
		if (!slot) {
			if (this.slots.size >= 8)
				throw new ToolError(
					"unavailable",
					"Eight compiler installations are already active; retry after idle cleanup.",
				);
			slot = { tail: Promise.resolve(), generation: -1 };
			this.slots.set(runtime.key, slot);
		}
		const current = slot;
		current.idle?.abort();
		const run = current.tail.then(async () => {
			if (deadline.aborted) throw new ToolError("timeout", "TypeScript query expired while queued.");
			if (this.closed) throw new ToolError("unavailable", "Worktree bridge is closing.");
			const generation = this.generation;
			try {
				// A fresh legacy diagnostic peer prevents unversioned pushes from an earlier check.
				if (current.client && (current.generation !== generation || name === "diagnostics")) {
					await current.client.close();
					current.client = undefined;
				}
				const fresh = !current.client;
				if (!current.client) {
					if (deadline.aborted || this.closed)
						throw new ToolError("timeout", "TypeScript query expired before initialization.");
					current.client = new LanguageClient(this.root, runtime, this.processes, this.sleep);
					current.generation = generation;
					current.unwatch ??= this.files.watch(runtime.installation, () => this.invalidate());
				}
				const client = current.client;
				const expired = () => {
					void client.close().catch(() => {});
				};
				deadline.addEventListener("abort", expired, { once: true });
				if (deadline.aborted) {
					await client.close();
					throw new ToolError("timeout", "TypeScript query expired.");
				}
				try {
					return await client.bounded(async () => {
						if (fresh) await client.initialize();
						for (const opened of client.openedFiles()) {
							await this.resolver.file(relative(this.root, opened));
							const contents = await this.files.readFile(opened);
							if (contents === undefined || Buffer.byteLength(contents) > 1024 * 1024)
								throw new ToolError("changed", "An opened source changed or disappeared; retry.");
							await client.sync(opened, contents);
						}
						// Revalidate every call, including calls that waited in the serialization queue.
						if ((await this.resolver.file(input.path)) !== file)
							throw new ToolError("changed", "Source path changed; retry.");
						const text = await this.files.readFile(file);
						if (text === undefined || Buffer.byteLength(text) > 1024 * 1024)
							throw new ToolError("invalid_input", "Source is missing or exceeds 1 MiB.");
						if (positioned) {
							const line = text.split(/\r?\n/)[input.line!];
							if (line === undefined || input.character! > line.length)
								throw new ToolError("invalid_input", "Position is outside the source file.");
						}
						const uri = await client.sync(file, text);
						const result = await client.query(
							name,
							uri,
							positioned ? { line: input.line!, character: input.character! } : undefined,
							input.query,
						);
						if (generation !== this.generation || (await this.files.readFile(file)) !== text)
							throw new ToolError(
								"changed",
								"Worktree changed during the query; retry for current results.",
							);
						const bounded = await this.bound(result);
						return {
							status: "ok",
							compilerVersion: runtime.version,
							package: relative(this.root, runtime.packagePath) || ".",
							...bounded,
						};
					});
				} finally {
					deadline.removeEventListener("abort", expired);
				}
			} catch (error) {
				await current.client?.close();
				current.client = undefined;
				if (error instanceof ToolError && error.code !== "unavailable") throw error;
				throw new ToolError(
					"unavailable",
					`TypeScript ${runtime.version} failed for ${relative(this.root, runtime.packagePath) || "."}; repair ${relative(this.root, runtime.packagePath) || "."}/node_modules/typescript and retry.`,
				);
			}
		});
		current.tail = run.catch(() => {});
		try {
			return await run;
		} finally {
			// Only arm idle cleanup when every queued operation has settled.
			if (current.tail) {
				const tail = current.tail;
				void tail.then(() => {
					if (current.tail !== tail || this.closed) return;
					current.idle?.abort();
					const idle = new AbortController();
					current.idle = idle;
					void this.sleep(60000, idle.signal)
						.then(async () => {
							if (idle.signal.aborted || current.tail !== tail) return;
							const cleanup = current.tail.then(async () => {
								await current.client?.close();
								current.client = undefined;
								current.unwatch?.();
								current.unwatch = undefined;
								if (current.tail === cleanup) this.slots.delete(runtime.key);
							});
							current.tail = cleanup;
							await cleanup;
						})
						.catch(() => {});
				});
			}
		}
	}
	private async bound(value: unknown): Promise<{ result: unknown; truncated: boolean }> {
		let nodes = 0;
		let characters = 0;
		let truncated = false;
		const visit = async (entry: unknown, depth: number): Promise<unknown> => {
			if (++nodes > 2000 || depth > 12 || characters > 48000) {
				truncated = true;
				return null;
			}
			if (typeof entry === "string") {
				const text = entry.slice(0, Math.min(8000, Math.max(0, 48000 - characters)));
				characters += text.length;
				truncated ||= text.length < entry.length;
				return text;
			}
			if (Array.isArray(entry)) {
				truncated ||= entry.length > 100;
				const result = [];
				for (const item of entry.slice(0, 100)) result.push(await visit(item, depth + 1));
				return result;
			}
			if (entry && typeof entry === "object") {
				const result: Record<string, unknown> = {};
				const entries = Object.entries(entry);
				truncated ||= entries.length > 30;
				for (const [key, item] of entries.slice(0, 30)) {
					if ((key === "uri" || key === "targetUri") && typeof item === "string") {
						try {
							const path = fileURLToPath(item);
							const canonical = await this.files.realpath(path);
							result[key === "uri" ? "path" : "targetPath"] = inside(this.root, canonical)
								? relative(this.root, canonical)
								: canonical;
							result["external"] = !inside(this.root, canonical);
						} catch {
							result["external"] = true;
							result["unavailableLocation"] = true;
						}
					} else result[key] = await visit(item, depth + 1);
				}
				return result;
			}
			return entry;
		};
		const result = await visit(value ?? null, 0);
		const serialized = JSON.stringify(result);
		if (serialized.length > 64000) return { result: { preview: serialized.slice(0, 60000) }, truncated: true };
		return { result, truncated };
	}
	async close(): Promise<void> {
		this.closed = true;
		this.unwatch();
		await Promise.all(
			[...this.slots.values()].map(async (slot) => {
				slot.idle?.abort();
				slot.unwatch?.();
				// Closing wakes pending diagnostic queries and rejects outstanding JSON-RPC requests.
				await slot.client?.close();
				await slot.tail;
			}),
		);
		this.slots.clear();
	}
}
