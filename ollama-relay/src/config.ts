import { Buffer } from "node:buffer";

export const readToken = (env: NodeJS.ProcessEnv): string => {
	const token = env["OLLAMA_RELAY_TOKEN"];
	if (!token || !/^[A-Za-z0-9._~-]{32,256}$/u.test(token))
		throw new Error("OLLAMA_RELAY_TOKEN must contain 32–256 URL-safe characters");
	return token;
};

export const relayConfig = (env: NodeJS.ProcessEnv) => ({
	bearer: Buffer.from(`Bearer ${readToken(env)}`),
	pairingPort: 8080,
	inferencePort: 8081,
});

export const workerConfig = (env: NodeJS.ProcessEnv) => {
	const token = readToken(env);
	let url: URL;
	try {
		url = new URL(env["OLLAMA_RELAY_URL"] ?? "");
	} catch {
		throw new Error("OLLAMA_RELAY_URL must be a wss:// URL ending in /pair");
	}
	if (url.protocol !== "wss:" || url.username || url.password || url.search || url.hash || url.pathname !== "/pair")
		throw new Error("OLLAMA_RELAY_URL must be a wss:// URL ending in /pair");
	const context = env["OLLAMA_CONTEXT_LENGTH"] ?? "164000";
	if (!/^[1-9][0-9]*$/u.test(context) || !Number.isSafeInteger(Number(context)))
		throw new Error("OLLAMA_CONTEXT_LENGTH must be a positive integer");
	return { url, token, context, ollamaAddress: "127.0.0.1:11434" };
};
