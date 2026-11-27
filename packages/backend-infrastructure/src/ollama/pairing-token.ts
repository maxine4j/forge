export const readToken = (env: NodeJS.ProcessEnv): string => {
	const token = env["OLLAMA_RELAY_TOKEN"];
	if (!token || !/^[A-Za-z0-9._~-]{32,256}$/u.test(token))
		throw new Error("OLLAMA_RELAY_TOKEN must contain 32–256 URL-safe characters");
	return token;
};
