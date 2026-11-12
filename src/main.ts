import * as files from "@forge/backend-infrastructure/file";
import { createLogger } from "@forge/backend-infrastructure/logger";
import { sleep } from "@forge/backend-infrastructure/sleep";

import { DockerRuntimeState } from "./docker/docker-runtime-state.ts";
import { DockerSupervisor } from "./docker/docker-supervisor.ts";
import { supervisorProcess } from "./docker/supervisor-process.ts";
import { Lifecycle } from "./http/lifecycle.ts";
import { start } from "./start.ts";

const log = createLogger("ForgeProcess");
const lifecycle = new Lifecycle();
let stopping = false;
const stop = async (exitCode: number): Promise<void> => {
	if (exitCode) process.exitCode = exitCode;
	if (stopping) return;
	stopping = true;
	try {
		await lifecycle.shutdown();
	} catch (err) {
		process.exitCode = 1;
		log.error({ err }, "Forge cleanup failed");
	}
	process.exit(process.exitCode ?? exitCode);
};
for (const signal of ["SIGINT", "SIGTERM"] as const)
	process.on(signal, () => {
		log.info({ signal }, "Forge stopping");
		void stop(0);
	});
for (const event of ["uncaughtException", "unhandledRejection"] as const)
	process.on(event, (err: unknown) => {
		log.fatal({ failure: err, event }, "Forge fatal failure");
		void stop(1);
	});
const options = process.argv.includes("--container-git-config") ? { containerGitConfig: "/run/forge/gitconfig" } : {};
const launch = async () => {
	if (!process.argv.includes("--supervise-docker")) return start(lifecycle, options);
	if (process.getuid?.() !== 0) throw new Error("Docker supervisor requires root");
	process.setgroups?.([]);
	const runtimeState = new DockerRuntimeState(files);
	const supervisor = new DockerSupervisor({
		reset: () => runtimeState.reset(),
		docker: () =>
			supervisorProcess(
				"dind",
				[
					"dockerd",
					"--config-file=/etc/forge-docker.json",
					"--host=unix:///run/forge/docker.sock",
					"--group=agent",
					"--data-root=/var/lib/forge-docker",
					"--exec-root=/run/forge-docker",
					"--pidfile=/run/forge-docker.pid",
					"--storage-driver=vfs",
				],
				{},
				sleep,
			),
		forge: () =>
			supervisorProcess(
				process.execPath,
				[process.argv[1]!, ...process.argv.slice(2).filter((arg) => arg !== "--supervise-docker")],
				{ uid: 1000, gid: 1000 },
				sleep,
			),
		warn: (message) => log.warn(message),
	});
	lifecycle.register(() => supervisor.stop());
	await supervisor.start((code) => {
		void stop(code);
	});
};
void launch().catch((err: unknown) => {
	log.fatal({ failure: err }, "Forge startup failed");
	void stop(1);
});
