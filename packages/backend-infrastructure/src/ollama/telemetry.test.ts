import { describe, expect, it } from "vitest";

import { readTelemetry } from "./telemetry.ts";

const sample = {
	type: "telemetry",
	ready: true,
	contextWindow: 64000,
	hostMemory: { total: 100, free: 50 },
	loadedModels: { count: 1, size: 40, sizeVram: 20 },
	gpus: [{ utilization: null, memoryUsed: null, memoryTotal: null }],
};
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));

describe("telemetry frames", () => {
	it("accepts unavailable device counters and discards extra properties", () => {
		expect(readTelemetry(encode({ ...sample, token: "secret" }))).toEqual(sample);
		expect(readTelemetry(encode({ ...sample, concurrency: 2 }))).toEqual({ ...sample, concurrency: 2 });
	});
	it("rejects malformed and unbounded reports", () => {
		for (const value of [
			{ ...sample, contextWindow: 0 },
			...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null].map((concurrency) => ({ ...sample, concurrency })),
			{ ...sample, loadedModels: { count: -1, size: 0, sizeVram: 0 } },
			{ ...sample, gpus: [{ utilization: 101, memoryUsed: null, memoryTotal: null }] },
			{ ...sample, gpus: Array(33).fill(sample.gpus[0]) },
			{ ...sample, padding: "x".repeat(8192) },
		])
			expect(() => readTelemetry(encode(value))).toThrow();
	});
});
