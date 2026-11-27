import { expect, test, vi } from "vitest";

import { pollOllamaRelay, readRelayInventory } from "./ollama-relay-poller.ts";

const worker = { workerId: "gpu-1", contextWindow: 32000, concurrency: 1 };

test("validates the complete inventory, including duplicate and invalid entries", () => {
	expect(readRelayInventory({ providers: [worker] })).toEqual([worker]);
	for (const providers of [
		[worker, worker],
		Array(17).fill(worker),
		[{ ...worker, workerId: "GPU" }],
		[{ ...worker, concurrency: 0 }],
		[{ ...worker, contextWindow: 1.5 }],
		[{ ...worker, concurrency: undefined }],
	])
		expect(() => readRelayInventory({ providers })).toThrow();
});

test("polls immediately, waits between attempts, recovers from errors, and stops", async () => {
	const abort = new AbortController();
	const releases: (() => void)[] = [];
	const sleep = vi.fn(
		(_ms: number, signal?: AbortSignal) =>
			new Promise<void>((resolve) => {
				releases.push(resolve);
				signal?.addEventListener("abort", () => resolve(), { once: true });
			}),
	);
	const fetcher = vi
		.fn()
		.mockResolvedValueOnce(new Response(null, { status: 404 }))
		.mockResolvedValue(Response.json({ providers: [worker] }));
	const reconcile = vi.fn(async () => {});
	const warn = vi.fn();
	const loop = pollOllamaRelay("http://relay", fetcher, sleep, reconcile, warn, abort.signal);
	await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
	expect(fetcher).toHaveBeenCalledTimes(1);
	expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
	expect(warn).toHaveBeenCalledOnce();
	expect(sleep.mock.calls[0]?.[0]).toBe(30_000);
	releases.shift()!();
	await vi.waitFor(() => expect(reconcile).toHaveBeenCalledWith([worker]));
	await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(2));
	abort.abort();
	await loop;
	expect(fetcher).toHaveBeenCalledTimes(2);
	await pollOllamaRelay(undefined, fetcher, sleep, reconcile, warn, new AbortController().signal);
	expect(fetcher).toHaveBeenCalledTimes(2);
});

test("aborts a stalled body on shutdown without overlapping requests", async () => {
	const abort = new AbortController();
	const fetcher = vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response);
	const reconcile = vi.fn(async () => {});
	const sleep = vi.fn();
	const loop = pollOllamaRelay("http://relay", fetcher, sleep, reconcile, vi.fn(), abort.signal);
	await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
	expect(sleep).not.toHaveBeenCalled();
	abort.abort();
	await loop;
	expect(reconcile).not.toHaveBeenCalled();
});

test("request deadline includes a stalled response body", async () => {
	const abort = new AbortController();
	const fetcher = vi.fn(async () => ({ ok: true, json: () => new Promise(() => {}) }) as Response);
	const warn = vi.fn(() => abort.abort());
	await pollOllamaRelay("http://relay", fetcher, vi.fn(), vi.fn(), warn, abort.signal);
	expect(warn).toHaveBeenCalledOnce();
	expect(fetcher).toHaveBeenCalledOnce();
}, 7_000);
