import { expect, test } from "vitest";

import { workerConfig } from "./config.ts";
import { createMacosCollector, parseBattery, parseHardware, parsePower } from "./macos-telemetry.ts";
import { collectTelemetry, loadedModelMemory, parseNvidiaMetrics } from "./worker-telemetry.ts";

test("parses macOS identity, power source and fractional power readings", () => {
	expect(
		parseHardware(JSON.stringify({ SPHardwareDataType: [{ chip_type: "Apple M4", machine_name: "MacBook Pro" }] })),
	).toEqual({ chipName: "Apple M4", deviceModel: "MacBook Pro" });
	expect(
		parseHardware(JSON.stringify({ SPHardwareDataType: [{ cpu_type: "Intel Core", machine_model: "MacPro7,1" }] })),
	).toEqual({ chipName: "Intel Core", deviceModel: "MacPro7,1" });
	expect(parseHardware("invalid")).toEqual({ chipName: null, deviceModel: null });
	expect(parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 0%; discharging")).toEqual({
		batteryPercent: 0,
		powerSource: "battery",
	});
	expect(parseBattery("Now drawing from 'AC Power'")).toEqual({ batteryPercent: null, powerSource: "ac" });
	expect(parsePower("GPU HW active residency: 12.5%\nCombined Power (CPU + GPU + ANE): 1500 mW")).toEqual({
		utilization: 12.5,
		powerWatts: 1.5,
	});
	expect(parsePower("permission denied")).toEqual({ utilization: null, powerWatts: null });
});

test("caches successful identity probes and isolates unavailable power", async () => {
	const calls: string[] = [];
	const collector = createMacosCollector(
		async (command) => {
			calls.push(command);
			if (command.endsWith("system_profiler"))
				return JSON.stringify({
					SPHardwareDataType: [
						{ chip_type: "Apple M4", machine_name: "MacBook Pro", serial_number: "secret" },
					],
				});
			if (command.endsWith("sw_vers")) return "15.2\n";
			if (command.endsWith("pmset")) return "Now drawing from 'AC Power'\n -InternalBattery-0 42.5%; charging";
			throw new Error("permission denied");
		},
		async () => "0.5.0",
		true,
	);
	const signal = new AbortController().signal;
	const first = await collector(signal);
	expect(first).toEqual({
		macos: {
			chipName: "Apple M4",
			deviceModel: "MacBook Pro",
			macosVersion: "15.2",
			ollamaVersion: "0.5.0",
			batteryPercent: 42.5,
			powerSource: "ac",
			powerWatts: null,
		},
		gpus: [],
	});
	await collector(signal);
	expect(calls.filter((command) => command.endsWith("system_profiler"))).toHaveLength(1);
	expect(calls.filter((command) => command.endsWith("sw_vers"))).toHaveLength(1);
	expect(calls.filter((command) => command.endsWith("sudo"))).toHaveLength(2);
});

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
