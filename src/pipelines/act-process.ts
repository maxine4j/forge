import { spawn } from "node:child_process";
import { join } from "node:path";

import type * as Files from "@forge/backend-infrastructure/file";
import type { ISleep } from "@forge/backend-infrastructure/sleep";
import type { PipelineInput } from "@forge/contracts/pipelines";

import { DOCKER_HOST, type IDockerCommand } from "../docker/docker-command.ts";
import { ActLines } from "./status-parser.ts";
import type { ActExecution } from "./types.ts";
import { runnerImages } from "./workflow.ts";

export interface IPipelineProcess {
	available(): Promise<void>;
	run(
		execution: ActExecution,
		input: PipelineInput,
		signal: AbortSignal,
		record: (line: string) => void,
	): Promise<number>;
	cleanup(runId: string): Promise<void>;
}
export function actArguments(execution: ActExecution, input: PipelineInput): string[] {
	return [
		input.event,
		"--directory",
		execution.source,
		"--workflows",
		execution.workflow,
		"--eventpath",
		execution.payload,
		"--json",
		"--bind",
		"--rm",
		"--pull=false",
		"--no-cache-server",
		"--env-file",
		"/dev/null",
		"--secret-file",
		"/dev/null",
		"--var-file",
		"/dev/null",
		"--input-file",
		"/dev/null",
		"--env",
		"DOCKER_HOST=unix:///var/run/docker.sock",
		"--container-daemon-socket",
		DOCKER_HOST,
		"--container-options-policy",
		"restrict",
		"--action-cache-path",
		join(execution.root, "actions"),
		...Object.entries(runnerImages).flatMap(([label, image]) => ["--platform", `${label}=${image}`]),
	];
}
/** Streaming process boundary with an allowlisted environment and a private invocation directory. */
export class ActProcess implements IPipelineProcess {
	constructor(
		private readonly docker: IDockerCommand,
		private readonly files: Pick<typeof Files, "writeFile" | "readFile" | "readdir">,
		private readonly sleep: ISleep,
		private readonly path: string,
		private readonly executable = "act",
	) {}
	async available(): Promise<void> {
		await this.docker.run(["info", "--format", "{{.ServerVersion}}"]);
	}
	async run(
		execution: ActExecution,
		input: PipelineInput,
		signal: AbortSignal,
		record: (line: string) => void,
	): Promise<number> {
		if (signal.aborted) throw new Error("Pipeline interrupted");
		const home = join(execution.root, "home");
		const child = spawn(this.executable, actArguments(execution, input), {
			cwd: execution.root,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				PATH: this.path,
				HOME: home,
				XDG_CONFIG_HOME: home,
				XDG_CACHE_HOME: home,
				DOCKER_CONFIG: home,
				DOCKER_HOST,
				FORGE_PIPELINE_RUN_ID: execution.root.split("/").at(-1)!,
				LANG: "C.UTF-8",
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_TERMINAL_PROMPT: "0",
				GIT_ASKPASS: "/bin/false",
			},
		});
		const diagnostics: Buffer[] = [];
		let retained = 0;
		const streams = [new ActLines(record), new ActLines(record)];
		let failure: unknown;
		const kill = (signal: NodeJS.Signals) => {
			if (child.pid) {
				try {
					process.kill(-child.pid, signal);
				} catch {
					/* Group already exited. */
				}
			}
		};
		const grace = new AbortController();
		const stop = () => {
			kill("SIGTERM");
			void this.sleep(1000, grace.signal).then(
				() => kill("SIGKILL"),
				() => {},
			);
		};
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		try {
			const code = await new Promise<number>((resolve) => {
				child.on("error", (error) => {
					failure = error;
				});
				[child.stdout, child.stderr].forEach((stream, index) =>
					stream.on("data", (chunk: Buffer) => {
						const remaining = 10 * 1024 * 1024 - retained;
						if (remaining > 0) {
							const copy = Buffer.from(chunk.subarray(0, remaining));
							diagnostics.push(copy);
							retained += copy.length;
						}
						streams[index]!.push(chunk);
					}),
				);
				child.on("exit", () => kill("SIGKILL"));
				child.on("close", (code) => resolve(code ?? -1));
			});
			for (const stream of streams) stream.end();
			await this.files.writeFile(join(execution.root, "diagnostics.jsonl"), Buffer.concat(diagnostics));
			if (failure) throw failure;
			return code;
		} finally {
			grace.abort();
			signal.removeEventListener("abort", stop);
		}
	}
	async cleanup(runId: string): Promise<void> {
		if (!/^[a-f0-9-]{36}$/u.test(runId)) throw new Error("Invalid resource owner");
		// Find orphaned groups by a private inherited marker, never by stale PIDs alone.
		const entries = await this.files.readdir("/proc");
		if (entries.length > 16384) throw new Error("Process inventory capacity exceeded");
		for (const entry of entries) {
			if (!/^[0-9]+$/u.test(entry)) continue;
			try {
				const before = await this.files.readFile(`/proc/${entry}/stat`);
				const env = await this.files.readFile(`/proc/${entry}/environ`);
				if (!before || !env?.split("\0").includes(`FORGE_PIPELINE_RUN_ID=${runId}`)) continue;
				const after = await this.files.readFile(`/proc/${entry}/stat`);
				if (
					!after
					|| before.slice(before.lastIndexOf(")") + 2).split(" ")[19]
						!== after.slice(after.lastIndexOf(")") + 2).split(" ")[19]
				)
					continue;
				const group = Number(after.slice(after.lastIndexOf(")") + 2).split(" ")[2]);
				if (Number.isSafeInteger(group) && group > 1 && group !== process.pid) process.kill(-group, "SIGKILL");
			} catch (error) {
				if (
					!(
						typeof error === "object"
						&& error !== null
						&& "code" in error
						&& ["ENOENT", "ESRCH", "EACCES"].includes(String(error.code))
					)
				)
					throw error;
			}
		}
		const prefix = `act-forge-${runId}-`;
		// v0.2.97 prefixes job, service, action containers and job volumes/networks with the workflow name.
		for (const kind of ["container", "network", "volume"] as const) {
			const names = (
				await this.docker.run([
					kind,
					"ls",
					...(kind === "container" ? ["--all"] : []),
					"--format",
					kind === "container" ? "{{.Names}}" : "{{.Name}}",
				])
			).split("\n");
			for (const name of names.filter((name) => name.startsWith(prefix) && /^[a-zA-Z0-9_.-]+$/u.test(name))) {
				await this.docker.run([
					kind,
					"rm",
					...(kind === "container" ? ["--force", "--volumes"] : []),
					"--",
					name,
				]);
			}
		}
	}
}
