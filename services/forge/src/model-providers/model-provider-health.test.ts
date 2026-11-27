import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test, vi } from "vitest";

import { modelProviderHealth } from "./model-provider-health.ts";

const local = {
	id: "id",
	name: "Local",
	kind: "ollama" as const,
	endpoint: "http://localhost/prefix/v1",
	retired: false,
	maxConcurrentAgents: 1,
};
const openai = { ...local, kind: "openai" as const };

test("checks Ollama model lists and preserves the path prefix", async () => {
	const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data: [] })));
	const check = modelProviderHealth(
		request,
		async () => {},
		async () => false,
		sleep,
	);
	expect(await check(local)).toBe("healthy");
	expect(String(request.mock.calls[0]?.[0])).toBe("http://localhost/prefix/v1/models");
	request.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "model" }] })));
	expect(await check(local)).toBe("healthy");
	request.mockResolvedValueOnce(new Response("", { status: 429 }));
	expect(await check(local)).toBe("usage-limits-reached");
	request.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{}] })));
	expect(await check(local)).toBe("unhealthy");
});

test("aborts a timed-out model list", async () => {
	let expire: () => void = () => {};
	const timer = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				expire = resolve;
			}),
	);
	const request = vi.fn<typeof fetch>(
		(_url, options) =>
			new Promise((_resolve, reject) => {
				options?.signal?.addEventListener("abort", () => reject(new Error("timeout")));
			}),
	);
	const check = modelProviderHealth(
		request,
		async () => {},
		async () => false,
		timer,
	);
	const result = check(local);
	expect(timer).toHaveBeenCalledWith(5000, expect.any(AbortSignal));
	expire();
	expect(await result).toBe("unhealthy");
});

test("checks the Codex catalog before quota", async () => {
	const catalog = vi.fn(async () => {});
	const quota = vi.fn(async () => true);
	const check = modelProviderHealth(fetch, catalog, quota, sleep);
	expect(await check(openai)).toBe("usage-limits-reached");
	quota.mockRejectedValueOnce(new Error());
	expect(await check(openai)).toBe("healthy");
	catalog.mockRejectedValueOnce(new Error());
	expect(await check(openai)).toBe("unhealthy");
	expect(quota).toHaveBeenCalledTimes(2);
});
