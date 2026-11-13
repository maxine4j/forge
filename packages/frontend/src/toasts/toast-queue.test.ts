import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToastQueue } from "./toast-queue.ts";

describe("toast queue", () => {
	let queue: ToastQueue;
	beforeEach(() => {
		vi.useFakeTimers();
		queue = new ToastQueue();
	});
	afterEach(() => {
		queue.dispose();
		vi.useRealTimers();
	});
	it("expires FIFO entries three seconds after each becomes visible", () => {
		queue.notify("first");
		vi.advanceTimersByTime(2000);
		queue.notify("second");
		queue.notify("third");
		vi.advanceTimersByTime(1000);
		expect(queue.snapshot()?.message).toBe("second");
		vi.advanceTimersByTime(2999);
		expect(queue.snapshot()?.message).toBe("second");
		vi.advanceTimersByTime(1);
		expect(queue.snapshot()?.message).toBe("third");
		vi.advanceTimersByTime(3000);
		expect(queue.snapshot()).toBeUndefined();
	});
	it("merges active repeats and restarts timeout and sweep revision", () => {
		queue.notify("failure");
		const first = queue.snapshot()!;
		vi.advanceTimersByTime(2500);
		queue.notify("failure");
		expect(queue.snapshot()).toMatchObject({ id: first.id, count: 2, revision: 1, deadline: Date.now() + 3000 });
		vi.advanceTimersByTime(2500);
		expect(queue.snapshot()?.count).toBe(2);
		queue.notify("failure");
		expect(queue.snapshot()?.count).toBe(3);
		vi.advanceTimersByTime(3000);
		expect(queue.snapshot()).toBeUndefined();
	});
	it("counts queued repeats without reordering or changing the active deadline", () => {
		queue.notify("first");
		const deadline = queue.snapshot()?.deadline;
		queue.notify("second");
		queue.notify("third");
		queue.notify("second");
		expect(queue.snapshot()?.deadline).toBe(deadline);
		queue.dismiss();
		expect(queue.snapshot()).toMatchObject({ message: "second", count: 2, deadline: Date.now() + 3000 });
		queue.dismiss();
		expect(queue.snapshot()?.message).toBe("third");
	});
	it("starts fresh counts after dismissal and expiry", () => {
		queue.notify("same");
		queue.notify("same");
		queue.dismiss();
		queue.notify("same");
		expect(queue.snapshot()?.count).toBe(1);
		vi.advanceTimersByTime(3000);
		queue.notify("same");
		expect(queue.snapshot()?.count).toBe(1);
	});
	it("unsubscribes and clears timers and listeners on teardown", () => {
		const listener = vi.fn();
		const unsubscribe = queue.subscribe(listener);
		queue.notify("one");
		expect(listener).toHaveBeenCalledTimes(1);
		unsubscribe();
		queue.notify("two");
		expect(listener).toHaveBeenCalledTimes(1);
		queue.subscribe(listener);
		queue.dispose();
		expect(vi.getTimerCount()).toBe(0);
		expect(queue.snapshot()).toBeUndefined();
		vi.advanceTimersByTime(10000);
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
