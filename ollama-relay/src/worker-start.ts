import { spawn } from "node:child_process";
import { connect } from "node:net";

import { createLogger } from "@forge/backend-infrastructure/logger";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { WebSocket } from "ws";

import { workerConfig } from "./config.ts";
import { OllamaClient } from "./ollama-client.ts";
import { maxRequestBytes } from "./types.ts";
import { WorkerSession, type IOllamaClient } from "./worker-session.ts";

const logger = createLogger("ollama-relay-worker");

export const startWorker = async (signal: AbortSignal): Promise<void> => {
	const config = workerConfig(process.env);
	await requireFreePort();
	signal.throwIfAborted();
	const lifetime = new AbortController();
	const stop = () => lifetime.abort();
	signal.addEventListener("abort", stop, { once: true });
	const env = { ...process.env };
	delete env["OLLAMA_RELAY_TOKEN"];
	delete env["OLLAMA_RELAY_URL"];
	const ollama = spawn("ollama", ["serve"], {
		stdio: "ignore",
		env: {
			...env,
			OLLAMA_HOST: config.ollamaAddress,
			OLLAMA_KV_CACHE_TYPE: "q8_0",
			OLLAMA_FLASH_ATTENTION: "1",
			OLLAMA_NUM_PARALLEL: "1",
			OLLAMA_CONTEXT_LENGTH: config.context,
			OLLAMA_NO_CLOUD: "1",
		},
	});
	let childStopped = false;
	const stopped = new Promise<string>((resolve) => {
		ollama.once("error", (error) =>
			resolve(
				"code" in error && error.code === "ENOENT"
					? "ollama is not installed or not on PATH"
					: "Could not start ollama serve",
			),
		);
		ollama.once("exit", (code, reason) => resolve(`ollama serve stopped (${code ?? reason})`));
	}).then((message) => {
		childStopped = true;
		lifetime.abort();
		return message;
	});
	const local = new OllamaClient(`http://${config.ollamaAddress}`, fetch);
	try {
		await waitForModel(local, lifetime.signal);
		await pair(config.url, config.token, local, lifetime.signal);
		if (childStopped && !signal.aborted) throw new Error(await stopped);
	} catch (error) {
		if (childStopped && !signal.aborted) throw new Error(await stopped);
		if (!signal.aborted) throw error;
	} finally {
		lifetime.abort();
		signal.removeEventListener("abort", stop);
		if (!childStopped) {
			ollama.kill("SIGTERM");
			const cleanup = new AbortController();
			await Promise.race([stopped, sleep(5000, cleanup.signal)]);
			cleanup.abort();
			if (!childStopped) ollama.kill("SIGKILL");
		}
		await stopped;
	}
};

const requireFreePort = async (): Promise<void> => {
	await new Promise<void>((resolve, reject) => {
		const socket = connect({ host: "127.0.0.1", port: 11434 });
		socket.once("connect", () => {
			socket.destroy();
			reject(new Error("Port 11434 is already in use. Stop the existing Ollama server first."));
		});
		socket.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNREFUSED") resolve();
			else reject(new Error("Could not check Ollama's loopback port"));
		});
	});
};

const waitForModel = async (client: OllamaClient, signal: AbortSignal): Promise<void> => {
	const readiness = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
	while (!readiness.aborted) {
		const result = await client
			.hasLocalModel(AbortSignal.any([readiness, AbortSignal.timeout(2000)]))
			.catch(() => undefined);
		if (result === true) return;
		if (result === false) throw new Error("Install a local Ollama model before starting the relay worker");
		await sleep(500, readiness).catch(() => {});
	}
	throw new Error("Ollama did not become ready within 30 seconds");
};

const pair = async (url: URL, token: string, ollama: IOllamaClient, signal: AbortSignal): Promise<void> => {
	let delay = 500;
	while (!signal.aborted) {
		let opened = false;
		const socket = new WebSocket(url, {
			headers: { Authorization: `Bearer ${token}` },
			handshakeTimeout: 10_000,
			maxPayload: maxRequestBytes,
			perMessageDeflate: false,
			rejectUnauthorized: true,
		});
		const stop = () => socket.terminate();
		signal.addEventListener("abort", stop, { once: true });
		let result: number | undefined;
		try {
			result = await new Promise<number | undefined>((resolve) => {
				let status: number | undefined;
				let heartbeat = new AbortController();
				const resetHeartbeat = () => {
					heartbeat.abort();
					heartbeat = new AbortController();
					void sleep(45_000, heartbeat.signal).then(stop, () => {});
				};
				const worker = new WorkerSession(socket, ollama);
				socket.once("open", () => {
					opened = true;
					logger.info("Paired with Ollama relay");
					resetHeartbeat();
				});
				socket.on("ping", resetHeartbeat);
				socket.once("unexpected-response", (_request, response) => {
					status = response.statusCode;
					response.destroy();
					stop();
				});
				socket.once("close", () => {
					heartbeat.abort();
					void worker.settle().then(() => resolve(status));
				});
			});
		} finally {
			signal.removeEventListener("abort", stop);
		}
		if (signal.aborted) return;
		if (result === 401 || result === 403) throw new Error(`Relay pairing authorization failed (HTTP ${result})`);
		logger.warn({ status: result }, "Relay connection unavailable, retrying");
		if (opened) delay = 500;
		await sleep(delay, signal);
		delay = Math.min(delay * 2, 15_000);
	}
};
