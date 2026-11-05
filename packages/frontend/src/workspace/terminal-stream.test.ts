import { expect, test } from "vitest";

import { TerminalStream } from "./terminal-stream.ts";

test("paste chunks bound serialized UTF8 including JSON escapes and preserve Unicode", () => {
	const stream = new TerminalStream({ write: (_data, complete) => complete(), reset: () => {} });
	const pasted = '😀\u0001\n\t"\\'.repeat(5000);
	const frames = stream.input(pasted);
	expect(frames.length).toBeGreaterThan(1);
	for (const frame of frames) {
		expect(new TextEncoder().encode(frame).length).toBeLessThanOrEqual(16384);
		expect(JSON.parse(frame).type).toBe("input");
	}
	expect(frames.map((frame) => JSON.parse(frame).data).join("")).toBe(pasted);
});

test("reconnect drains queued output before supplying cursor; duplicate replay is not rendered", async () => {
	const writes: string[] = [];
	const pending: (() => void)[] = [];
	const stream = new TerminalStream({
		write: (data, complete) => {
			writes.push(data);
			pending.push(complete);
		},
		reset: () => {},
	});
	const initial = stream.prepare("first");
	pending.shift()!();
	expect(await initial).toBe(0);
	stream.output(1, "first output");
	stream.output(1, "duplicate");
	expect(writes).toEqual(["", "first output"]);
	const reconnect = stream.prepare("first");
	let resolved = false;
	void reconnect.then(() => {
		resolved = true;
	});
	await Promise.resolve();
	expect(resolved).toBe(false);
	pending.shift()!();
	pending.shift()!();
	expect(await reconnect).toBe(1);
	stream.output(1, "replay duplicate");
	expect(writes).not.toContain("replay duplicate");
	stream.gap(10);
	const afterGap = stream.prepare("first");
	pending.shift()!();
	expect(await afterGap).toBe(10);
});

test("switching session drains old writes before reset and old callbacks cannot advance new cursor", async () => {
	const pending: (() => void)[] = [];
	let resets = 0;
	const stream = new TerminalStream({
		write: (_data, complete) => pending.push(complete),
		reset: () => {
			resets++;
		},
	});
	const initial = stream.prepare("first");
	pending.shift()!();
	await initial;
	stream.output(99, "old bytes");
	const oldCallback = pending.shift()!;
	const next = stream.prepare("second");
	expect(resets).toBe(1);
	oldCallback();
	pending.shift()!();
	expect(await next).toBe(0);
	expect(resets).toBe(2);
	oldCallback();
	const reconnect = stream.prepare("second");
	pending.shift()!();
	expect(await reconnect).toBe(0);
});
