import { parseArgs } from "node:util";

import { readToken } from "@forge/backend-infrastructure/ollama/pairing-token";
import { isWorkerId } from "@forge/backend-infrastructure/ollama/types";

export const workerConfig = (env: NodeJS.ProcessEnv, args: string[]) => {
	const { values } = parseArgs({
		args,
		options: {
			"worker-id": { type: "string" },
			"relay-base-url": { type: "string" },
			"context-window": { type: "string", default: "164000" },
		},
	});
	const workerId = values["worker-id"];
	if (!workerId || !isWorkerId(workerId))
		throw new Error("--worker-id must be a lowercase worker ID (1–63 characters)");
	const origin = values["relay-base-url"] ?? "";
	const urlError = "--relay-base-url must be an HTTPS origin without credentials, query, or fragment";
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		throw new Error(urlError);
	}
	if (!/^https:\/\/[^/\\@?#\s]+\/?$/iu.test(origin) || /\s/u.test(origin)) throw new Error(urlError);
	url.protocol = "wss:";
	url.pathname = "/pair";
	const context = values["context-window"];
	if (!/^[1-9][0-9]*$/u.test(context) || /\D/u.test(context) || !Number.isSafeInteger(Number(context)))
		throw new Error("--context-window must be a positive integer");
	return { url, workerId, token: readToken(env), context, ollamaAddress: "127.0.0.1:11434" };
};
