import { expect, test, vi } from "vitest";

import { QuotaCollector } from "./quota-collector.ts";

test("shutdown drains an in-flight request without saving or scheduling another sample", async () => {
	let resolve!: (value: undefined) => void;
	const limits = vi.fn(
		() =>
			new Promise<undefined>((done) => {
				resolve = done;
			}),
	);
	const save = vi.fn(),
		sleep = vi.fn();
	const collector = new QuotaCollector({ limits }, { save, read: vi.fn() }, () => new Date(), sleep, vi.fn());
	collector.start();
	collector.start();
	const dispatch = collector.sample();
	const completion = collector.sample();
	expect(dispatch).toBe(completion);
	expect(limits).toHaveBeenCalledTimes(1);
	const closing = collector.close();
	resolve(undefined);
	await closing;
	expect(save).not.toHaveBeenCalled();
	expect(sleep).not.toHaveBeenCalled();
});

test("samples at startup, serializes requests, recovers failure and aborts its timer", async () => {
	const limits = vi
		.fn()
		.mockRejectedValueOnce(new Error("offline"))
		.mockResolvedValue({
			windows: [
				{
					bucketId: "stable",
					bucket: "Display",
					minutes: 10080,
					usedPercent: 120,
					resetsAt: "2026-11-15T00:00:00.000Z",
				},
				{ bucketId: "short", bucket: "Short", minutes: 300, usedPercent: 5 },
			],
		});
	const save = vi.fn(async () => {}),
		failed = vi.fn();
	let wake: (() => void) | undefined;
	const sleep = vi.fn(
		(_delay: number, signal?: AbortSignal) =>
			new Promise<void>((resolve) => {
				wake = resolve;
				signal?.addEventListener("abort", () => resolve(), { once: true });
			}),
	);
	const collector = new QuotaCollector(
		{ limits },
		{ save, read: vi.fn() },
		() => new Date("2026-11-12T00:00:00.000Z"),
		sleep,
		failed,
	);
	collector.start();
	collector.start();
	await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));
	expect(limits).toHaveBeenCalledTimes(1);
	expect(failed).toHaveBeenCalledTimes(1);
	expect(sleep.mock.calls[0]?.[0]).toBe(300_000);
	wake!();
	await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
	expect(save.mock.calls[0]).toEqual([
		expect.objectContaining({ bucketId: "stable", bucket: "Display", usedPercent: 100 }),
	]);
	await collector.close();
	expect(limits).toHaveBeenCalledTimes(2);
});
