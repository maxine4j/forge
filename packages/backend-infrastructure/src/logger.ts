import { AsyncLocalStorage } from "node:async_hooks";

import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

const context = new AsyncLocalStorage<{ task: string; taskId: string }>();
const serializeError = (error: unknown): unknown =>
	error instanceof Error
		? { ...pino.stdSerializers.errWithCause(error), stack: pino.stdSerializers.err(error).stack }
		: error;
const options: LoggerOptions = {
	timestamp: pino.stdTimeFunctions.isoTime,
	mixin: () => ({ ...context.getStore() }),
	serializers: { err: serializeError, error: serializeError, failure: serializeError },
};

/** All backend loggers share automatic async task context. */
export const logger = pino(options, process.stdout);
export const createLogger = (component: string, destination?: DestinationStream): Logger =>
	(destination ? pino(options, destination) : logger).child({ component });
export const withLogContext = <T>(fields: { task: string; taskId: string }, run: () => T): T =>
	context.run(fields, run);
