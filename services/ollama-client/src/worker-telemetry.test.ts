import { expect, test } from "vitest";

import { workerConfig } from "./config.ts";
import { collectTelemetry, loadedModelMemory, parseNvidiaMetrics } from "./worker-telemetry.ts";

const env = { OLLAMA_RELAY_TOKEN: "x".repeat(32), OLLAMA_CONTEXT_LENGTH: "42" };
const options = ["--worker-id", "gpu-1", "--relay-base-url", "https://relay.example:8443/"];

test("derives an authenticated pairing target from the required CLI flags", () => {
	const config = workerConfig(env, options);
	expect(config.url.href).toBe("wss://relay.example:8443/pair");
	expect(config.workerId).toBe("gpu-1");
	expect(config.context).toBe("164000");
	expect(workerConfig(env, [...options, "--context-window", "32000"]).context).toBe("32000");
	expect(() => workerConfig({}, options)).toThrow("OLLAMA_RELAY_TOKEN");
	for (const id of ["-gpu", "GPU", "gpu_", "gpu\n", "x".repeat(64)])
		expect(() => workerConfig(env, ["--worker-id", id, ...options.slice(2)])).toThrow("--worker-id");
	for (const url of [
		"http://relay.example",
		"https://@relay.example",
		"https://relay.example/pair",
		"https://relay.example?",
	])
		expect(() => workerConfig(env, [...options.slice(0, 3), url])).toThrow("--relay-base-url");
	expect(() => workerConfig(env, [...options, "--max-memory", "8"])).toThrow();
});

test("aggregates model memory and tolerates incomplete device probes", async () => {
	expect(
		loadedModelMemory({
			models: [
				{ size: 1000, size_vram: 700 },
				{ size: 200, size_vram: 0 },
			],
		}),
	).toEqual({
		count: 2,
		size: 1200,
		sizeVram: 700,
	});
	expect(loadedModelMemory({ models: [{ size: 1000 }] })).toBeNull();
	expect(parseNvidiaMetrics("67, 5, 10\nN/A, N/A, 20\nN/A, N/A, N/A")).toEqual([
		{ utilization: 67, memoryUsed: 5 * 1024 ** 2, memoryTotal: 10 * 1024 ** 2 },
		{ utilization: null, memoryUsed: null, memoryTotal: 20 * 1024 ** 2 },
	]);
	const unavailable = async () => {
		throw new Error("Unavailable");
	};
	expect(
		await collectTelemetry(
			32000,
			{
				hasLocalModel: async () => true,
				hostMemory: () => ({ total: 1024, free: 512 }),
				loadedModels: unavailable,
				gpus: unavailable,
			},
			new AbortController().signal,
		),
	).toEqual({
		type: "telemetry",
		ready: true,
		contextWindow: 32000,
		concurrency: 1,
		hostMemory: { total: 1024, free: 512 },
		loadedModels: null,
		gpus: [],
	});
	const configured = workerConfig(env, [...options, "--context-window", "48000"]);
	const telemetry = await collectTelemetry(
		Number(configured.context),
		{
			hasLocalModel: async () => true,
			hostMemory: () => null,
			loadedModels: async () => null,
			gpus: async () => [],
		},
		new AbortController().signal,
		3,
	);
	expect(telemetry).toMatchObject({ contextWindow: 48000, concurrency: 3 });
});
