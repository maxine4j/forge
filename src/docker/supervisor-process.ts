import { spawn, type SpawnOptions } from "node:child_process";

import type { ISleep } from "@forge/backend-infrastructure/sleep";

import type { SupervisedProcess } from "./docker-supervisor.ts";

/** Direct children retain inherited logging and tini reaps orphaned descendants. */
export const supervisorProcess = (
	command: string,
	args: string[],
	options: SpawnOptions,
	sleep: ISleep,
): SupervisedProcess => {
	const child = spawn(command, args, { ...options, stdio: "inherit" });
	let exited = false;
	const done = new Promise<number>((resolve) => {
		child.on("error", () => {
			exited = true;
			resolve(1);
		});
		child.on("exit", (code) => {
			exited = true;
			resolve(code ?? 1);
		});
	});
	return {
		done,
		stop: async (timeoutMs) => {
			if (exited) return;
			child.kill("SIGTERM");
			const timer = new AbortController();
			await Promise.race([done, sleep(timeoutMs, timer.signal).catch(() => {})]);
			timer.abort();
			if (!exited) child.kill("SIGKILL");
			await done;
		},
	};
};
