import { createLogger } from "@forge/backend-infrastructure/logger";

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
void start(lifecycle).catch((err: unknown) => {
	log.fatal({ failure: err }, "Forge startup failed");
	void stop(1);
});
