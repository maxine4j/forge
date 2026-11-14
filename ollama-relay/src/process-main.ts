import { createLogger } from "@forge/backend-infrastructure/logger";

export const run = (component: string, start: (signal: AbortSignal) => Promise<void>): void => {
	const logger = createLogger(component);
	const shutdown = new AbortController();
	const stop = () => shutdown.abort();
	const fatal = () => {
		logger.error("Unexpected process failure");
		process.exitCode = 1;
		stop();
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	process.once("uncaughtException", fatal);
	process.once("unhandledRejection", fatal);
	void start(shutdown.signal)
		.catch((error: unknown) => {
			logger.error(error instanceof Error ? error.message : "Unexpected process failure");
			process.exitCode = 1;
		})
		.finally(() => {
			process.off("SIGINT", stop);
			process.off("SIGTERM", stop);
			process.off("uncaughtException", fatal);
			process.off("unhandledRejection", fatal);
		});
};
