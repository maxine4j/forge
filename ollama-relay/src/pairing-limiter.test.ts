import { expect, test } from "vitest";

import { canonicalIp, PairingLimiter } from "./pairing-limiter.ts";

test("escalates at five failures, caps, and expires exactly", () => {
	let now = 0;
	const limiter = new PairingLimiter(() => now);
	for (const minutes of [15, 30, 60, 120, 240, 480, 960, 1920, 1920]) {
		for (let i = 0; i < 5; i++) {
			expect(limiter.blocked("a")).toBeUndefined();
			limiter.fail("a");
		}
		expect(limiter.blocked("a")).toBe(minutes * 60);
		now += 1;
		expect(limiter.blocked("a")).toBe(minutes * 60);
		now += minutes * 60_000 - 1;
		expect(limiter.blocked("a")).toBeUndefined();
	}
});

test("success, quiet time, independent addresses and eviction reset histories", () => {
	let now = 0;
	const limiter = new PairingLimiter(() => now, 2);
	for (let i = 0; i < 4; i++) limiter.fail("a");
	limiter.fail("b");
	limiter.success("a");
	limiter.fail("a");
	for (let i = 0; i < 3; i++) limiter.fail("a");
	expect(limiter.blocked("a")).toBeUndefined();
	limiter.fail("a");
	expect(limiter.blocked("a")).toBe(900);
	now++;
	limiter.fail("c");
	for (let i = 0; i < 4; i++) limiter.fail("b");
	expect(limiter.blocked("b")).toBeUndefined();
	now += 7 * 24 * 60 * 60_000;
	limiter.fail("b");
	expect(limiter.blocked("b")).toBeUndefined();
});

test("blocked attempts preserve the deadline and postpone quiet reset", () => {
	let quietNow = 0;
	const quietLimiter = new PairingLimiter(() => quietNow);
	for (let i = 0; i < 5; i++) quietLimiter.fail("a");
	quietNow = 899_000;
	expect(quietLimiter.blocked("a")).toBe(1);
	quietNow = 7 * 24 * 60 * 60_000;
	for (let i = 0; i < 5; i++) quietLimiter.fail("a");
	expect(quietLimiter.blocked("a")).toBe(1800);
	let now = 0;
	const limiter = new PairingLimiter(() => now);
	for (let level = 0; level < 8; level++) {
		for (let i = 0; i < 5; i++) limiter.fail("a");
		const seconds = limiter.blocked("a")!;
		now += seconds * 1000;
	}
	for (let i = 0; i < 5; i++) limiter.fail("a");
	now += 1000;
	expect(limiter.blocked("a")).toBe(32 * 3600 - 1);
	now += 32 * 3600_000 - 1000;
	for (let i = 0; i < 5; i++) limiter.fail("a");
	expect(limiter.blocked("a")).toBe(32 * 3600);
});

test("canonicalizes IP literals", () => {
	expect(canonicalIp(" 2001:0DB8:0:0:0:0:0:1 ")).toBe("2001:db8::1");
	expect(canonicalIp("::ffff:192.0.2.1")).toBe("192.0.2.1");
	expect(canonicalIp("::ffff:c000:201")).toBe("192.0.2.1");
	expect(canonicalIp("bad")).toBeUndefined();
});
