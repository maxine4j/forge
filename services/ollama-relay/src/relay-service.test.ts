import { Buffer } from "node:buffer";

import { afterEach, expect, test, vi } from "vitest";

import { RelayService, type IInferenceResponse, type IWorkerConnection } from "./relay-service.ts";

const response = () => ({
	headers: vi.fn<IInferenceResponse["headers"]>(),
	write: vi.fn<IInferenceResponse["write"]>().mockResolvedValue(undefined),
	end: vi.fn<IInferenceResponse["end"]>(),
	fail: vi.fn<IInferenceResponse["fail"]>(),
});

const setup = () => {
	const worker = { send: vi.fn<IWorkerConnection["send"]>().mockResolvedValue(undefined), terminate: vi.fn() };
	const relay = new RelayService(
		(delay, signal) =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, delay);
				signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
			}),
		30,
		100,
	);
	relay.pair(worker);
	const submit = (body = "{}", signal = new AbortController().signal) => {
		const output = response();
		relay.infer(Buffer.from(body), output, signal);
		return output;
	};
	const finish = (id: number) => {
		relay.receive(worker, { type: "headers", id, status: 200, contentType: "application/json" });
		relay.receive(worker, { type: "end", id });
	};
	return { relay, worker, submit, finish };
};

afterEach(() => vi.useRealTimers());

test("keeps four FIFO waiters and expires queued work", async () => {
	vi.useFakeTimers();
	const { relay, worker, submit, finish } = setup();
	const first = submit();
	const second = submit("second");
	const third = submit("third");
	const fourth = submit("fourth");
	const fifth = submit("fifth");
	expect(submit().fail).toHaveBeenCalledWith(429, "queue_full", expect.any(String));
	finish(1);
	expect(first.end).toHaveBeenCalledOnce();
	expect(worker.send).toHaveBeenLastCalledWith(Buffer.from("second"));
	finish(2);
	expect(second.end).toHaveBeenCalledOnce();
	expect(worker.send).toHaveBeenLastCalledWith(Buffer.from("third"));
	await vi.advanceTimersByTimeAsync(30);
	for (const waiting of [fourth, fifth]) {
		expect(waiting.fail).toHaveBeenCalledWith(429, "queue_timeout", expect.any(String));
	}
	expect(third.fail).not.toHaveBeenCalled();
	relay.disconnect(worker);
});

test("acknowledges after writes and waits for cancellation before dispatching", async () => {
	const { relay, worker, submit, finish } = setup();
	const caller = new AbortController();
	const first = submit("first", caller.signal);
	const { promise, resolve } = Promise.withResolvers<void>();
	first.write.mockReturnValueOnce(promise);
	submit("second");
	relay.receive(worker, { type: "headers", id: 1, status: 200, contentType: "text/event-stream" });
	relay.receive(worker, Buffer.from("delta"));
	expect(worker.send).toHaveBeenCalledTimes(2);
	resolve();
	await promise;
	expect(worker.send).toHaveBeenLastCalledWith({ type: "ack", id: 1 });
	caller.abort();
	expect(worker.send).toHaveBeenLastCalledWith({ type: "cancel", id: 1 });
	relay.receive(worker, { type: "cancelled", id: 1 });
	expect(worker.send).toHaveBeenLastCalledWith(Buffer.from("second"));
	finish(2);
});

test("times out upstream, drops disconnected work and accepts a fresh pairing", async () => {
	vi.useFakeTimers();
	const { relay, worker, submit, finish } = setup();
	const stalled = submit();
	await vi.advanceTimersByTimeAsync(100);
	expect(stalled.fail).toHaveBeenCalledWith(504, "upstream_timeout", expect.any(String));
	expect(worker.send).toHaveBeenLastCalledWith({ type: "cancel", id: 1 });
	relay.receive(worker, { type: "cancelled", id: 1 });
	const active = submit();
	const waiting = submit();
	relay.disconnect(worker);
	for (const lost of [active, waiting, submit()]) {
		expect(lost.fail).toHaveBeenCalledWith(503, "worker_offline", expect.any(String));
	}
	expect(relay.pair(worker)).toBe(true);
	const next = submit();
	finish(4);
	expect(next.end).toHaveBeenCalledOnce();
});
