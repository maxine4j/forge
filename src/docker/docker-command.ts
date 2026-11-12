import { execFile, type ChildProcess } from "node:child_process";

import type { ISleep } from "@forge/backend-infrastructure/sleep";

export const DOCKER_HOST = "unix:///run/forge/docker.sock";
export class DockerError extends Error {
	constructor(
		readonly code:
			| "docker-unavailable"
			| "docker-busy"
			| "invalid-request"
			| "docker-operation-not-found"
			| "docker-resource-missing" = "docker-unavailable",
	) {
		super(code);
	}
}
export interface IDockerCommand {
	run(args: string[], timeoutMs?: number): Promise<string>;
}
/** No ambient contexts, credentials, remote endpoints, shell expansion, or unbounded CLI output. */
export class DockerCommand implements IDockerCommand {
	private readonly active = new Set<ChildProcess>();
	private closing = false;
	constructor(
		private readonly sleep: ISleep,
		private readonly executable = "docker",
		private readonly prefix: string[] = [],
	) {}
	run(args: string[], timeoutMs = 15_000): Promise<string> {
		if (this.closing) return Promise.reject(new DockerError());
		return new Promise((resolve, reject) => {
			const timer = new AbortController();
			const child = execFile(
				this.executable,
				[...this.prefix, "--host", DOCKER_HOST, ...args],
				{
					env: { PATH: process.env["PATH"], HOME: "/nonexistent", DOCKER_CONFIG: "/nonexistent", LANG: "C" },
					maxBuffer: 4 * 1024 * 1024,
					killSignal: "SIGKILL",
				},
				(error, stdout, stderr) => {
					this.active.delete(child);
					timer.abort();
					if (error)
						reject(
							new DockerError(
								!error.killed
									&& /No such (container|image|volume|network|object)|network .+ not found/i.test(
										stderr,
									)
									? "docker-resource-missing"
									: "docker-unavailable",
							),
						);
					else resolve(stdout.trim());
				},
			);
			this.active.add(child);
			void this.sleep(timeoutMs, timer.signal).then(
				() => child.kill("SIGKILL"),
				() => {},
			);
		});
	}
	async close(): Promise<void> {
		this.closing = true;
		await Promise.all(
			[...this.active].map(
				(child) =>
					new Promise<void>((resolve) => {
						child.once("close", () => resolve());
						child.kill("SIGKILL");
					}),
			),
		);
	}
}
