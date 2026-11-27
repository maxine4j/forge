import { createLogger } from "@forge/backend-infrastructure/logger";
import { sleep } from "@forge/backend-infrastructure/sleep";

import { relayConfig } from "./config.ts";
import { PairingLimiter } from "./pairing-limiter.ts";
import { RelayHttp } from "./relay-http.ts";

export const start = async (signal: AbortSignal): Promise<void> => {
	const config = relayConfig(process.env);
	const relay = new RelayHttp(
		config.bearer,
		sleep,
		new PairingLimiter(Date.now),
		createLogger("ollama-relay"),
		Date.now,
	);
	await relay.listen("0.0.0.0", config.pairingPort, config.inferencePort);
	if (!signal.aborted)
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	await relay.close();
};
