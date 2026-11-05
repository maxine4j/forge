import { expect, test } from "vitest";

import { GitTransport } from "./git-transport.ts";

test.each(["exit", "deadline"])("cleans helper groups after leader %s", async (mode) => {
	const root = await mkdtemp(join(tmpdir(), "forge-git-group-"));
	const marker = join(root, "pids");
	const git = new GitTransport(sleep, {
		executable: process.execPath,
		prefix: [fileURLToPath(new URL("../../tests/fixtures/git-peer.mjs", import.meta.url))],
		deadlineMs: mode === "deadline" ? 1000 : 10_000,
	});
	let pids: { leader: number; child: number } | undefined;
	try {
		const result = git.run([mode, marker]);
		void result.catch(() => {});
		for (let count = 0; count < 200 && !pids; count++) {
			const value = await readFile(marker);
			if (value) pids = JSON.parse(value);
			else await sleep(10);
		}
		if (!pids) throw new Error("Git fixture did not start");
		const completed = await Promise.race([
			result.then(
				() => "success",
				() => "failed",
			),
			sleep(2000).then(() => "stalled"),
		]);
		expect(completed).toBe(mode === "exit" ? "success" : "failed");
		let alive = true;
		for (let count = 0; count < 200 && alive; count++) {
			try {
				process.kill(pids.child, 0);
				await sleep(10);
			} catch {
				alive = false;
			}
		}
		expect(alive).toBe(false);
	} finally {
		if (pids) {
			try {
				process.kill(-pids.leader, "SIGKILL");
			} catch {}
		}
		await git.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("system Git executes without a shell and rejects forbidden protocols with sanitized diagnostics", async () => {
	const git = new GitTransport();
	expect(await git.run(["--version"])).toMatch(/^git version /);
	await expect(git.run(["ls-remote", "file:///SECRET_LOCAL_PATH"])).rejects.toThrow(/^Git operation failed$/);
	await expect(git.run(["ls-remote", "ext::echo SECRET"])).rejects.toThrow(/^Git operation failed$/);
});

test("binary transport preserves bytes while text transport rejects invalid UTF-8", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-git-bytes-"));
	const git = new GitTransport();
	try {
		await git.run(["init", "--bare", root]);
		const input = join(root, "bytes");
		const bytes = Buffer.from([255, 254, 10, 0]);
		await writeFile(input, bytes);
		const hash = (await git.run(["-C", root, "hash-object", "-w", input])).trim();
		expect(await git.runBytes(["-C", root, "cat-file", "blob", hash])).toEqual(bytes);
		await expect(git.run(["-C", root, "cat-file", "blob", hash])).rejects.toThrow("Git operation failed");
	} finally {
		await git.close();
		await rm(root, { recursive: true, force: true });
	}
});
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { mkdtemp, readFile, rm, writeFile } from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";

test("close cancels only owned Git groups and waits for their streams; later commands are rejected", async () => {
	const root = await mkdtemp(join(tmpdir(), "forge-git-close-"));
	const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
	const git = new GitTransport(sleep, {
		executable: process.execPath,
		prefix: [fileURLToPath(new URL("../../tests/fixtures/git-peer.mjs", import.meta.url))],
	});
	try {
		const marker = join(root, "pids");
		const result = git.run(["slow", marker]);
		void result.catch(() => {});
		let value: string | undefined;
		for (let count = 0; count < 200 && !value; count++) {
			value = await readFile(marker);
			if (!value) await sleep(10);
		}
		if (!value) throw new Error("Git fixture did not start");
		const pids: { leader: number; child: number } = JSON.parse(value);
		await git.close();
		await expect(result).rejects.toThrow("Git operation failed");
		for (const pid of [pids.leader, pids.child]) {
			let alive = true;
			for (let count = 0; count < 200 && alive; count++) {
				try {
					process.kill(pid, 0);
					await sleep(10);
				} catch {
					alive = false;
				}
			}
			expect(alive).toBe(false);
		}
		expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
		await expect(git.run(["--version"])).rejects.toThrow("Git operation failed");
	} finally {
		try {
			await git.close();
		} finally {
			unrelated.kill();
			await once(unrelated, "close");
			await rm(root, { recursive: true, force: true });
		}
	}
});
