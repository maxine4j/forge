import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test, vi } from "vitest";

import { LanguageProcesses } from "./process.ts";

test.each([false, true])(
	"server descendants are stopped in the inherited group (crash: %s)",
	async (crash) => {
		const root = await files.mkdtemp(join(tmpdir(), "forge-lsp-process-"));
		const entry = join(root, "peer.mjs");
		await files.writeFile(
			entry,
			`
		import {spawn} from 'node:child_process';
		import {writeFileSync} from 'node:fs';
		const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
		writeFileSync('descendant',String(child.pid));
		${crash ? "setTimeout(()=>process.exit(1),300);" : "setInterval(()=>{},1000);"}
	`,
		);
		const processes = new LanguageProcesses(process.execPath, entry, files.readFile, sleep, files.readdir);
		const child = processes.spawn(
			{ key: root, installation: root, packagePath: root, version: "7.0.2", kind: "native", entry },
			root,
		);
		try {
			await vi.waitFor(async () => expect(await files.readFile(join(root, "descendant"))).toMatch(/^\d+$/));
			const descendant = Number(await files.readFile(join(root, "descendant")));
			expect(await files.realpath(`/proc/${child.pid}/cwd`)).toBe(root);
			const group = (stat: string) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2];
			expect(group((await files.readFile(`/proc/${child.pid}/stat`))!)).toBe(
				group((await files.readFile(`/proc/${process.pid}/stat`))!),
			);
			if (crash) await sleep(500);
			await child.stop();
			await vi.waitFor(async () => {
				const stat = await files.readFile(`/proc/${descendant}/stat`);
				expect(!stat || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
			});
		} finally {
			await child.stop();
			await files.rm(root, { recursive: true, force: true });
		}
	},
	15000,
);
