import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test } from "vitest";

import { TypeScriptBridge } from "../../src/typescript-lsp/bridge.ts";
import { LanguageProcesses, type ILanguageProcesses } from "../../src/typescript-lsp/process.ts";

test.each(["typescript", "typescript-legacy"])(
	"real %s LSP isolates identical paths in two checkouts and refreshes edits/configuration",
	async (compiler) => {
		const root = await files.mkdtemp(join(tmpdir(), "forge-lsp-integration-"));
		const require = createRequire(import.meta.url);
		const processes = new LanguageProcesses(
			process.execPath,
			require.resolve("typescript-language-server/lib/cli.mjs"),
			files.readFile,
			sleep,
			files.readdir,
		);
		const bridges: TypeScriptBridge[] = [];
		const roots: string[] = [];
		const observed: ILanguageProcesses = {
			spawn: (runtime, checkout) => {
				roots.push(checkout);
				const child = processes.spawn(runtime, checkout);
				void files.realpath(`/proc/${child.pid}/cwd`).then((cwd) => expect(cwd).toBe(checkout));
				return child;
			},
		};
		try {
			for (const [name, type, value] of [
				["one", "string", "'one'"],
				["two", "number", "42"],
			]) {
				const checkout = join(root, name!);
				await files.mkdir(join(checkout, "node_modules"), { recursive: true });
				await files.symlink(
					dirname(require.resolve(`${compiler}/package.json`)),
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
				bridges.push(new TypeScriptBridge(checkout, files, observed, sleep));
			}
			const input = { path: "index.ts", line: 0, character: 14 };
			const hovers = await Promise.all(bridges.map((bridge) => bridge.call("hover", input)));
			expect(new Set(roots)).toEqual(new Set([join(root, "one"), join(root, "two")]));
			expect(JSON.stringify(hovers[0])).toContain("string");
			expect(JSON.stringify(hovers[1])).toContain("number");
			const references = await Promise.all(bridges.map((bridge) => bridge.call("references", input)));
			for (const result of references) {
				expect(JSON.stringify(result)).toContain("index.ts");
				expect(result["status"]).toBe("ok");
			}
			for (const bridge of bridges) {
				expect(JSON.stringify(await bridge.call("definition", { ...input, line: 1 }))).toContain("index.ts");
				expect(JSON.stringify(await bridge.call("document_symbols", { path: "index.ts" }))).toContain("value");
				expect(
					JSON.stringify(await bridge.call("workspace_symbols", { path: "index.ts", query: "value" })),
				).toContain("value");
			}
			const clean = await bridges[0]!.call("diagnostics", { path: "index.ts" });
			expect(clean["result"]).toEqual([]);
			await files.writeFile(
				join(root, "one/index.ts"),
				'export const value: boolean = "wrong";\nconsole.log(value);\n',
			);
			await sleep(150);
			const diagnostics = await bridges[0]!.call("diagnostics", { path: "index.ts" });
			expect(JSON.stringify(diagnostics)).toContain("2322");
			expect(JSON.stringify(await bridges[0]!.call("hover", input))).toContain("boolean");
			expect(JSON.stringify(await bridges[1]!.call("hover", input))).toContain("number");
			await files.writeFile(
				join(root, "one/tsconfig.json"),
				'{"compilerOptions":{"strict":false},"include":["*.ts"]}',
			);
			await files.writeFile(
				join(root, "one/index.ts"),
				"export const value: boolean = true;\nconsole.log(value);\n",
			);
			await sleep(150);
			expect((await bridges[0]!.call("diagnostics", { path: "index.ts" }))["result"]).toEqual([]);
			await files.writeFile(join(root, "one/index.ts"), "export function value(x) { return x; }\n");
			await sleep(100);
			const relaxed = (await bridges[0]!.call("diagnostics", { path: "index.ts" }))["result"] as {
				severity: number;
			}[];
			expect(relaxed.filter((diagnostic) => diagnostic.severity === 1)).toEqual([]);
			await files.writeFile(
				join(root, "one/tsconfig.json"),
				'{"compilerOptions":{"strict":true},"include":["*.ts"]}',
			);
			await sleep(100);
			expect(JSON.stringify(await bridges[0]!.call("diagnostics", { path: "index.ts" }))).toContain("7006");
			await files.rm(join(root, "one/node_modules/typescript"));
			const other = compiler === "typescript" ? "typescript-legacy" : "typescript";
			await files.symlink(
				dirname(require.resolve(`${other}/package.json`)),
				join(root, "one/node_modules/typescript"),
			);
			await sleep(100);
			expect(
				(await bridges[0]!.call("hover", { path: "index.ts", line: 0, character: 17 }))["compilerVersion"],
			).toBe(other === "typescript" ? "7.0.2" : "6.0.3");
			expect(JSON.stringify(await bridges[1]!.call("hover", input))).toContain("number");
		} finally {
			await Promise.all(bridges.map((bridge) => bridge.close()));
			await files.rm(root, { recursive: true, force: true });
		}
	},
	90000,
);
