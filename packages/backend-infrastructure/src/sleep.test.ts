import { expect, test } from "vitest";

import { sleep } from "./sleep.ts";

test("sleep resolves after its delay and rejects when cancelled", async () => {
	await expect(sleep(1)).resolves.toBeUndefined();
	const controller = new AbortController();
	const pending = sleep(30, controller.signal);
	controller.abort();
	await expect(pending).rejects.toMatchObject({ name: "AbortError" });
	await expect(sleep(1, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
});
