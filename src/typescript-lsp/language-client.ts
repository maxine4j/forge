import { fileURLToPath, pathToFileURL } from "node:url";

import type { ISleep } from "@forge/backend-infrastructure/sleep";
import {
	createMessageConnection,
	StreamMessageReader,
	StreamMessageWriter,
	type MessageConnection,
} from "vscode-jsonrpc/node";
import type { InitializeResult, PublishDiagnosticsParams, ServerCapabilities } from "vscode-languageserver-protocol";
import { z } from "zod";

import type { ILanguageProcesses, LanguageProcess } from "./process.ts";
import { ToolError, type CompilerRuntime } from "./runtime-resolution.ts";

export class LanguageClient {
	private readonly child: LanguageProcess;
	private readonly rpc: MessageConnection;
	private capabilities: ServerCapabilities = {};
	private readonly documents = new Map<string, { text: string; version: number }>();
	private readonly diagnostics = new Map<string, PublishDiagnosticsParams>();
	private readonly changed = new Set<() => void>();
	private failed = false;
	private compilerIdentity: { version: string; source: string } | undefined;
	constructor(
		private readonly root: string,
		private readonly runtime: CompilerRuntime,
		processes: ILanguageProcesses,
		private readonly sleep: ISleep,
	) {
		this.child = processes.spawn(runtime, root);
		this.rpc = createMessageConnection(
			new StreamMessageReader(this.child.output),
			new StreamMessageWriter(this.child.input),
		);
		this.rpc.onRequest("workspace/applyEdit", () => ({
			applied: false,
			failureReason: "Forge TypeScript tools are read-only.",
		}));
		this.rpc.onRequest("workspace/configuration", (params: { items: unknown[] }) => params.items.map(() => ({})));
		this.rpc.onRequest("client/registerCapability", () => null);
		this.rpc.onRequest("window/workDoneProgress/create", () => null);
		this.rpc.onRequest("workspace/workspaceFolders", () => [{ uri: pathToFileURL(root).href, name: "worktree" }]);
		this.rpc.onNotification("$/typescriptVersion", (identity: { version: string; source: string }) => {
			this.compilerIdentity = identity;
			for (const notify of this.changed) notify();
		});
		this.rpc.onNotification("textDocument/publishDiagnostics", (params: PublishDiagnosticsParams) => {
			const document = this.documents.get(params.uri);
			if (document && (params.version === undefined || params.version === document.version)) {
				this.diagnostics.set(params.uri, params);
				for (const notify of this.changed) notify();
			}
		});
		const failed = () => {
			this.failed = true;
			for (const notify of this.changed) notify();
			void this.child.stop().catch(() => {});
		};
		this.rpc.onClose(failed);
		this.rpc.onError(failed);
		void this.child.done.then(failed, failed);
		this.rpc.listen();
	}
	async initialize(): Promise<void> {
		const uri = pathToFileURL(this.root).href;
		const result = await this.request<InitializeResult>("initialize", {
			processId: process.pid,
			rootPath: this.root,
			rootUri: uri,
			workspaceFolders: [{ uri, name: "worktree" }],
			capabilities: {
				general: { positionEncodings: ["utf-16"] },
				workspace: { configuration: true, workspaceFolders: true },
				textDocument: {
					publishDiagnostics: { versionSupport: true },
					diagnostic: {},
					synchronization: { didSave: true },
				},
			},
			initializationOptions: {
				disableAutomaticTypingAcquisition: true,
				...(this.runtime.kind === "tsserver"
					? { tsserver: { path: this.runtime.entry }, hostInfo: "forge" }
					: {}),
			},
		});
		this.capabilities = result.capabilities;
		if (this.capabilities.positionEncoding && this.capabilities.positionEncoding !== "utf-16")
			throw new ToolError("unsupported", "Compiler does not support UTF-16 positions.");
		await this.rpc.sendNotification("initialized", {});
		if (this.runtime.kind === "tsserver") {
			while (!this.compilerIdentity) {
				if (this.failed)
					throw new ToolError("unavailable", "TypeScript server exited before identifying its compiler.");
				await new Promise<void>((resolve) => {
					const wake = () => {
						this.changed.delete(wake);
						resolve();
					};
					this.changed.add(wake);
				});
			}
			if (
				this.compilerIdentity.source !== "user-setting"
				|| this.compilerIdentity.version !== this.runtime.version
			)
				throw new ToolError(
					"unavailable",
					"TypeScript adapter substituted a compiler; repair the selected package installation.",
				);
		}
	}
	async sync(file: string, text: string): Promise<string> {
		const uri = pathToFileURL(file).href;
		const previous = this.documents.get(uri);
		if (!previous) {
			if (this.documents.size >= 64)
				throw new ToolError("unavailable", "Compiler document limit reached; retry after idle cleanup.");
			this.documents.set(uri, { text, version: 1 });
			await this.rpc.sendNotification("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: /\.[cm]?tsx?$/.test(file)
						? file.endsWith("x")
							? "typescriptreact"
							: "typescript"
						: file.endsWith("x")
							? "javascriptreact"
							: "javascript",
					version: 1,
					text,
				},
			});
		} else if (previous.text !== text) {
			this.diagnostics.delete(uri);
			const version = previous.version + 1;
			this.documents.set(uri, { text, version });
			await this.rpc.sendNotification("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text }],
			});
			await this.rpc.sendNotification("textDocument/didSave", { textDocument: { uri }, text });
		}
		return uri;
	}
	openedFiles(): string[] {
		return [...this.documents.keys()].map((uri) => fileURLToPath(uri));
	}
	async query(
		tool: string,
		uri: string,
		position?: { line: number; character: number },
		query?: string,
	): Promise<unknown> {
		if (this.failed) throw new ToolError("unavailable", "TypeScript server exited; retry to recreate it.");
		if (tool === "diagnostics") {
			if (this.capabilities.diagnosticProvider) {
				const result = await this.request<{ kind: string; items?: unknown[] }>("textDocument/diagnostic", {
					textDocument: { uri },
				});
				if (result.kind !== "full" || !Array.isArray(result.items))
					throw new ToolError("unavailable", "Compiler did not return fresh diagnostics.");
				return result.items;
			}
			if (
				this.runtime.kind === "tsserver"
				&& this.capabilities.executeCommandProvider?.commands.includes("typescript.tsserverRequest")
			) {
				// Fixed read-only requests wait for all three diagnostic phases. An early
				// unversioned syntax push alone cannot establish a successful clean check.
				const location = z.object({ line: z.int().positive(), offset: z.int().positive() });
				const response = z.object({
					success: z.literal(true),
					body: z.array(
						z.object({
							message: z.string(),
							code: z.number(),
							category: z.string(),
							startLocation: location,
							endLocation: location,
						}),
					),
				});
				const diagnostics = [];
				for (const command of [
					"syntacticDiagnosticsSync",
					"semanticDiagnosticsSync",
					"suggestionDiagnosticsSync",
				]) {
					const result = response.parse(
						await this.request("workspace/executeCommand", {
							command: "typescript.tsserverRequest",
							arguments: [
								command,
								{ file: fileURLToPath(uri), includeLinePosition: true },
								{ expectsResult: true, isAsync: false },
							],
						}),
					);
					for (const diagnostic of result.body)
						diagnostics.push({
							message: diagnostic.message,
							code: diagnostic.code,
							source: "typescript",
							severity:
								diagnostic.category === "error"
									? 1
									: diagnostic.category === "warning"
										? 2
										: diagnostic.category === "suggestion"
											? 4
											: 3,
							range: {
								start: {
									line: diagnostic.startLocation.line - 1,
									character: diagnostic.startLocation.offset - 1,
								},
								end: {
									line: diagnostic.endLocation.line - 1,
									character: diagnostic.endLocation.offset - 1,
								},
							},
						});
				}
				return diagnostics;
			}
			// Legacy tsserver publishes unversioned diagnostics. The bridge creates a fresh
			// server for each diagnostic check, so these cannot belong to an older disk state.
			while (!this.diagnostics.has(uri)) {
				if (this.failed) throw new ToolError("unavailable", "TypeScript server exited during diagnostics.");
				await new Promise<void>((resolve) => {
					const wake = () => {
						this.changed.delete(wake);
						resolve();
					};
					this.changed.add(wake);
				});
			}
			return this.diagnostics.get(uri)!.diagnostics;
		}
		const methods: Record<string, [string, keyof ServerCapabilities]> = {
			hover: ["textDocument/hover", "hoverProvider"],
			definition: ["textDocument/definition", "definitionProvider"],
			references: ["textDocument/references", "referencesProvider"],
			document_symbols: ["textDocument/documentSymbol", "documentSymbolProvider"],
			workspace_symbols: ["workspace/symbol", "workspaceSymbolProvider"],
		};
		const [method, capability] = methods[tool]!;
		if (!this.capabilities[capability]) throw new ToolError("unsupported", `Compiler does not support ${tool}.`);
		return this.request(
			method,
			tool === "workspace_symbols"
				? { query: query ?? "" }
				: {
						textDocument: { uri },
						...(position ? { position } : {}),
						...(tool === "references" ? { context: { includeDeclaration: true } } : {}),
					},
		);
	}
	private request<T>(method: string, params: unknown): Promise<T> {
		if (this.failed)
			return Promise.reject(
				new ToolError("unavailable", "TypeScript server is unavailable; retry to recreate it."),
			);
		return this.rpc.sendRequest<T>(method, params);
	}
	async changedFile(uri?: string): Promise<void> {
		this.diagnostics.clear();
		if (uri && !this.failed)
			await this.rpc.sendNotification("workspace/didChangeWatchedFiles", { changes: [{ uri, type: 2 }] });
	}
	async bounded<T>(operation: () => Promise<T>, milliseconds = 30000): Promise<T> {
		const timer = new AbortController();
		try {
			return await Promise.race([
				operation(),
				this.sleep(milliseconds, timer.signal).then(() => {
					throw new ToolError(
						"timeout",
						"TypeScript request exceeded 30 seconds; retry to recreate the server.",
					);
				}),
			]);
		} finally {
			timer.abort();
		}
	}
	async close(): Promise<void> {
		this.failed = true;
		for (const wake of this.changed) wake();
		this.rpc.dispose();
		await this.child.stop();
	}
}
