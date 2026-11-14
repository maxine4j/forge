import { sleep } from "@forge/backend-infrastructure/sleep";

import { relayConfig } from "./config.ts";
import { RelayHttp } from "./relay-http.ts";
import { RelayService } from "./relay-service.ts";

export const start = async (signal: AbortSignal): Promise<void> => {
	const config = relayConfig(process.env);
	const relay = new RelayHttp(new RelayService(sleep), config.bearer, sleep);
	await relay.listen("0.0.0.0", config.pairingPort, config.inferencePort);
	if (!signal.aborted)
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
	await relay.close();
};
