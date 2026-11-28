import type { ModelProvider } from "@forge/contracts/model-providers";
import { expect, test, vi } from "vitest";

import { readRelayMetrics } from "./ollama-relay-metrics.ts";

test("isolates workers, validates metadata and matches the configured relay exactly", async () => {
	const provider = (name: string, endpoint = `http://relay/${name}/openai/v1`): ModelProvider => ({
		id: name,
		name,
		endpoint,
		kind: "ollama",
		retired: false,
		maxConcurrentAgents: 1,
	});
	const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
		if (String(url).includes("/bad/")) throw new Error("offline");
		return Response.json({
			workerId: "mac",
			freshness: "fresh",
			receivedAt: "2026-01-01T00:00:00.000Z",
			macos: {
				chipName: "M4",
				deviceModel: "Mac",
				macosVersion: "15",
				ollamaVersion: "1",
				batteryPercent: 0,
				powerWatts: 0,
				powerSource: "ac",
				serial: "secret",
			},
			gpus: [{ utilization: 0 }],
			hostMemory: { total: 8, free: 3 },
		});
	});
	const rows = await readRelayMetrics(
		"http://relay",
		[provider("mac"), provider("bad"), provider("other", "http://else/other/openai/v1")],
		fetcher,
	);
	expect(rows).toEqual([
		{
			providerId: "mac",
			freshness: "fresh",
			receivedAt: "2026-01-01T00:00:00.000Z",
			macos: {
				chipName: "M4",
				deviceModel: "Mac",
				macosVersion: "15",
				ollamaVersion: "1",
				batteryPercent: 0,
				powerWatts: 0,
				powerSource: "ac",
				gpuUtilization: 0,
				memory: { total: 8, free: 3 },
			},
		},
		{ providerId: "bad", freshness: "unavailable", receivedAt: null },
	]);
	expect(fetcher).toHaveBeenCalledTimes(2);
	expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
});
