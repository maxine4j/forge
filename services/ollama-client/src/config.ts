import { readToken } from "@forge/backend-infrastructure/ollama/pairing-token";

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
