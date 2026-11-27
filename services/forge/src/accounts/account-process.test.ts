import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm, stat } from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { describe, expect, it, vi } from "vitest";

import { AccountProcess } from "./account-process.ts";

describe("AccountProcess", () => {
	it("keeps gh diagnostics separate from structured stdout", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-account-streams-"));
		try {
			const processes = new AccountProcess(
				{
					dataDirectory: directory,
					path: process.env["PATH"] ?? "",
					codexExecutable: process.execPath,
					githubExecutable: process.execPath,
				},
				sleep,
			);
			await processes.initialize();
			let stdout = "";
			let stderr = "";
			const child = processes.spawn({
				program: "github",
				arguments: [
					"-e",
					"process.stdout.write('structured:'+process.env.DOCKER_HOST);process.stderr.write('diagnostic')",
				],
				onOutput: (chunk) => {
					stdout += chunk;
				},
				onStderr: (chunk) => {
					stderr += chunk;
				},
			});
			await child.done;
			expect(stdout).toBe("structured:unix:///run/forge/docker.sock");
			expect(stderr).toBe("diagnostic");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("expected process shutdown does not emit an unsuccessful-command warning", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-account-stop-"));
		const warn = vi.fn();
		try {
			const processes = new AccountProcess(
				{
					dataDirectory: directory,
					path: process.env["PATH"] ?? "",
					codexExecutable: process.execPath,
					githubExecutable: process.execPath,
				},
				sleep,
				{ warn, error: vi.fn() },
			);
			await processes.initialize();
			let ready: () => void = () => {};
			const started = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const child = processes.spawn({
				program: "codex",
				arguments: ["-e", "setInterval(()=>{},1000);process.stdout.write('ready')"],
				onOutput: () => ready(),
			});
			await started;
			await child.stop();
			expect(warn).not.toHaveBeenCalled();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("bounds combined stdout and stderr for short account commands", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-account-combined-"));
		try {
			const processes = new AccountProcess(
				{
					dataDirectory: directory,
					path: process.env["PATH"] ?? "",
					codexExecutable: process.execPath,
					githubExecutable: process.execPath,
				},
				sleep,
			);
			await processes.initialize();
			const child = processes.spawn({
				program: "github",
				arguments: ["-e", "process.stdout.write('x'.repeat(700));process.stderr.write('y'.repeat(700))"],
				outputLimit: 1024,
				onOutput: () => {},
			});
			await expect(child.done).rejects.toThrow("Account process unavailable");
			await child.stop();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("retains a bounded stderr tail without exhausting a long-lived Codex process", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-account-stderr-"));
		try {
			const processes = new AccountProcess(
				{
					dataDirectory: directory,
					path: process.env["PATH"] ?? "",
					codexExecutable: process.execPath,
					githubExecutable: process.execPath,
				},
				sleep,
			);
			await processes.initialize();
			const child = processes.spawn({
				program: "codex",
				arguments: [
					"-e",
					"process.stderr.write('x'.repeat(100000), () => process.stdout.write('still-running'))",
				],
				onOutput: () => {},
			});
			expect(await child.done).toBe(0);
			await child.stop();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("releases Codex ownership after a synchronous spawn failure", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-account-spawn-"));
		try {
			const processes = new AccountProcess(
				{
					dataDirectory: directory,
					path: process.env["PATH"] ?? "",
					codexExecutable: process.execPath,
					githubExecutable: process.execPath,
				},
				sleep,
			);
			await processes.initialize();
			expect(() => processes.spawn({ program: "codex", arguments: ["\u0000"], onOutput: () => {} })).toThrow(
				"Account process unavailable",
			);
			const child = processes.spawn({
				program: "codex",
				arguments: ["-e", "process.exit(0)"],
				onOutput: () => {},
			});
			expect(await child.done).toBe(0);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("creates restricted homes, excludes ambient tokens, and awaits child cleanup", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-account-process-"));
		try {
			const processes = new AccountProcess(
				{
					dataDirectory: directory,
					path: process.env["PATH"] ?? "",
					codexExecutable: process.execPath,
					githubExecutable: process.execPath,
				},
				sleep,
			);
			await processes.initialize();
			expect((await stat(join(directory, "codex"))).mode & 0o777).toBe(0o700);
			expect((await stat(join(directory, "github"))).mode & 0o777).toBe(0o700);
			let output = "";
			const child = processes.spawn({
				program: "github",
				arguments: [
					"-e",
					"process.stdout.write(JSON.stringify({home:process.env.GH_CONFIG_DIR,token:process.env.GH_TOKEN,key:process.env.OPENAI_API_KEY}))",
				],
				onOutput: (chunk) => {
					output += chunk;
				},
				outputLimit: 1024,
			});
			expect(await child.done).toBe(0);
			expect(JSON.parse(output)).toEqual({ home: join(directory, "github") });
			await child.stop();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("rejects output overflow and owns a single Codex process", async () => {
		const directory = await mkdtemp(join(tmpdir(), "forge-account-process-"));
		try {
			const processes = new AccountProcess(
				{
					dataDirectory: directory,
					path: process.env["PATH"] ?? "",
					codexExecutable: process.execPath,
					githubExecutable: process.execPath,
				},
				sleep,
			);
			await processes.initialize();
			const child = processes.spawn({
				program: "codex",
				arguments: ["-e", "process.stdout.write('x'.repeat(2048)); process.stdin.resume()"],
				outputLimit: 1024,
				onOutput: () => {},
			});
			expect(() => processes.spawn({ program: "codex", arguments: [], onOutput: () => {} })).toThrow(
				"Account process unavailable",
			);
			await expect(child.done).rejects.toThrow("Account process unavailable");
			await child.stop();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
