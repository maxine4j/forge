import { expect, test } from "vitest";

import { Lifecycle } from "./lifecycle.ts";

test("shutdown is idempotent, runs reverse acquisition order and finishes cleanup despite a failure", async () => {
	const lifecycle = new Lifecycle();
	const order: number[] = [];
	lifecycle.register(async () => {
		order.push(1);
	});
	lifecycle.register(async () => {
		order.push(2);
		throw new Error("cleanup");
	});
	lifecycle.register(async () => {
		order.push(3);
	});
	const result = lifecycle.shutdown();
	expect(lifecycle.shutdown()).toBe(result);
	await expect(result).rejects.toThrow("Cleanup failed");
	expect(order).toEqual([3, 2, 1]);
	expect(lifecycle.isOpen()).toBe(false);
});
