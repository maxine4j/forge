import { Buffer } from "node:buffer";

import { readToken } from "@forge/backend-infrastructure/ollama/pairing-token";

export const relayConfig = (env: NodeJS.ProcessEnv) => ({
	bearer: Buffer.from(`Bearer ${readToken(env)}`),
	pairingPort: 8080,
	inferencePort: 8081,
});
