import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { describe, expect, it, vi } from "vitest";

import { TerminalInventory } from "../../src/terminal/terminal-inventory.ts";
import { TerminalProcess } from "../../src/terminal/terminal-process.ts";

// The supported PTY runtime is Linux; run these via pnpm test:containers integration on macOS.
describe.skipIf(process.platform !== "linux")("real PTY", () => {
	it("runs curated Bash in the verified directory, resizes and awaits exit", async () => {
		const path = await mkdtemp(join(tmpdir(), "forge-pty-"));
		const adapter = new TerminalProcess(
			process.env["PATH"] ?? "",
			sleep,
			new TerminalInventory(files),
			process.platform,
		);
		let output = "";
		const child = await adapter.spawn({
			path,
			cols: 80,
			rows: 24,
			onOutput: (data) => {
				output += data;
			},
		});
		try {
			child.write("printf 'BASH:%s\\n' \"${BASH_VERSION:-missing}\"\r");
			await vi.waitFor(() => expect(output).toMatch(/BASH:\d+\.\d+/));
			child.write('printf \'DIR:%s HIST:%s KEY:%s\\n\' "$PWD" "$HISTFILE" "$OPENAI_API_KEY"\r');
			await vi.waitFor(() => expect(output).toContain(`DIR:${path} HIST:/dev/null KEY:`));
			child.resize(101, 37);
			child.write("stty size\r");
			await vi.waitFor(() => expect(output).toContain("37 101"));
			child.write("exit 9\r");
			expect(await child.done).toBe(9);
		} finally {
			await child.stop();
			await rm(path, { recursive: true, force: true });
		}
	});
	it("cleans ordinary foreground and background job groups on explicit stop", async () => {
		const path = await mkdtemp(join(tmpdir(), "forge-pty-stop-"));
		let output = "";
		const child = await new TerminalProcess(
			process.env["PATH"] ?? "",
			sleep,
			new TerminalInventory(files),
			process.platform,
		).spawn({
			path,
			cols: 80,
			rows: 24,
			onOutput: (data) => {
				output += data;
			},
		});
		try {
			child.write('sleep 300 & printf \'BG:%s\\n\' "$!"; sh -c \'printf "FG:%s\\n" "$$"; exec sleep 301\'\r');
			await vi.waitFor(() => expect(output).toMatch(/FG:\d+/));
			const pids = [Number(/BG:(\d+)/.exec(output)?.at(1)), Number(/FG:(\d+)/.exec(output)?.at(1))];
			await child.stop();
			for (const pid of pids)
				await vi.waitFor(async () => {
					const state = await files.readFile(`/proc/${pid}/stat`);
					expect(state === undefined || state.slice(state.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
				});
		} finally {
			await child.stop();
			await rm(path, { recursive: true, force: true });
		}
	});
	it("cleans same-session background jobs ignoring HUP after natural leader exit", async () => {
		const path = await mkdtemp(join(tmpdir(), "forge-pty-natural-"));
		let output = "";
		const child = await new TerminalProcess(
			process.env["PATH"] ?? "",
			sleep,
			new TerminalInventory(files),
			process.platform,
		).spawn({
			path,
			cols: 80,
			rows: 24,
			onOutput: (data) => {
				output += data;
			},
		});
		try {
			child.write("trap '' HUP; sleep 300 & printf 'BG:%s\\n' \"$!\"\r");
			await vi.waitFor(() => expect(output).toMatch(/BG:\d+/));
			const pid = Number(/BG:(\d+)/.exec(output)?.at(1));
			child.write("exit 0\r");
			await child.done;
			await vi.waitFor(async () => {
				const state = await files.readFile(`/proc/${pid}/stat`);
				expect(state === undefined || state.slice(state.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
			});
		} finally {
			await child.stop();
			await rm(path, { recursive: true, force: true });
		}
	});
	it("still kills the known owned shell and awaits it when descendant inventory fails", async () => {
		const path = await mkdtemp(join(tmpdir(), "forge-pty-inventory-"));
		const inventory = new TerminalInventory(files);
		let pid = 0;
		const child = await new TerminalProcess(
			process.env["PATH"] ?? "",
			sleep,
			{
				identify: async (id) => {
					pid = id;
					return inventory.identify(id);
				},
				groups: async () => {
					throw new Error("inventory unavailable");
				},
			},
			process.platform,
		).spawn({ path, cols: 80, rows: 24, onOutput: () => {} });
		try {
			await expect(child.stop()).rejects.toMatchObject({ code: "terminal-unavailable" });
			await expect(child.done).rejects.toMatchObject({ code: "terminal-unavailable" });
			await vi.waitFor(async () => {
				const state = await files.readFile(`/proc/${pid}/stat`);
				expect(state === undefined || state.slice(state.lastIndexOf(")") + 2).startsWith("Z ")).toBe(true);
			});
		} finally {
			await child.stop().catch(() => {});
			await rm(path, { recursive: true, force: true });
		}
	});
});
