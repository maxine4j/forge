import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import WebSocket from "ws";

import { PairingLimiter } from "../../ollama-relay/dist/pairing-limiter.js";
import { RelayHttp } from "../../ollama-relay/dist/relay-http.js";
import { Lifecycle } from "../dist/http/lifecycle.js";
import { start } from "../dist/start.js";

const root = await files.mkdtemp(join(tmpdir(), "forge-discovery-smoke-"));
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const relay = new RelayHttp(Buffer.from("Bearer secret"), sleep, new PairingLimiter(Date.now), { warn() {} }, Date.now);
const lifecycle = new Lifecycle();
let socket;
try {
	await relay.listen("127.0.0.1", 0, 0);
	socket = new WebSocket(`ws://127.0.0.1:${relay.ports.pairing}/pair`, {
		headers: { Authorization: "Bearer secret", "X-Forge-Worker-Id": "smoke-gpu" },
	});
	await once(socket, "open");
	socket.send(
		JSON.stringify({
			type: "telemetry",
			ready: true,
			contextWindow: 32768,
			concurrency: 1,
			hostMemory: null,
			loadedModels: null,
			gpus: [],
		}),
	);
	await pause(200);
	Object.assign(process.env, {
		FORGE_OWNER: "owner",
		FORGE_ORIGIN: "https://forge.example.test",
		FORGE_DATA_DIRECTORY: root,
		FORGE_PORT: String(port),
		FORGE_OLLAMA_RELAY_ORIGIN: `http://127.0.0.1:${relay.ports.inference}`,
	});
	await start(lifecycle);
	for (let attempt = 0; attempt < 100; attempt++) {
		const response = await fetch(`http://127.0.0.1:${port}/api/model-providers`, {
			headers: { "x-webauth-user": "owner" },
		});
		const providers = await response.json();
		if (
			providers.some(
				(provider) =>
					provider.name === "smoke-gpu"
					&& provider.contextWindow === 32768
					&& provider.supportedConcurrency === 1,
			)
		) {
			console.log("Forge discovered the named worker with context 32768 and concurrency 1");
			break;
		}
		if (attempt === 99) throw new Error(JSON.stringify(providers));
		await pause(100);
	}
} finally {
	socket?.terminate();
	await lifecycle.shutdown();
	await relay.close();
	await files.rm(root, { recursive: true, force: true });
}
