import { describe, expect, it } from "vitest";

import { arrowInput, controlInput, KeyboardDetector } from "./terminal-keyboard.ts";

const viewport = (height: number, extra = {}) => ({ height, width: 390, top: 0, left: 0, scale: 1, ...extra });

describe("terminal keyboard detection", () => {
	it("requires focus, touch, and both inclusive reduction thresholds", () => {
		for (const [baseline, below, threshold] of [
			[600, 481, 480],
			[1000, 801, 800],
		] as const) {
			const detector = new KeyboardDetector();
			expect(detector.measure(viewport(baseline), false, true)).toBe(false);
			expect(detector.measure(viewport(below), true, true)).toBe(false);
			expect(detector.measure(viewport(threshold), true, false)).toBe(false);
			expect(detector.measure(viewport(threshold), false, true)).toBe(false);
			expect(detector.measure(viewport(threshold), true, true)).toBe(true);
		}
	});
	it("retains the closed baseline through opening, scrolling, blur and dismissal", () => {
		const detector = new KeyboardDetector();
		detector.measure(viewport(800), false, true);
		expect(detector.measure(viewport(700), true, true)).toBe(false);
		expect(detector.measure(viewport(500, { top: 80, left: 10 }), true, true)).toBe(true);
		expect(detector.measure(viewport(510), false, true)).toBe(false);
		expect(detector.measure(viewport(510), true, true)).toBe(true);
		expect(detector.measure(viewport(800), true, true)).toBe(false);
	});
	it("ignores pinch zoom and reacquires a closed baseline after rotation", () => {
		const detector = new KeyboardDetector();
		detector.measure(viewport(800), false, true);
		expect(detector.measure(viewport(400, { scale: 2 }), true, true)).toBe(false);
		expect(detector.measure(viewport(800), true, true)).toBe(false);
		expect(detector.measure(viewport(390), true, true, true)).toBe(false);
		expect(detector.measure(viewport(270), true, true)).toBe(true);
	});
	it("rebases when rotated dimensions arrive after the orientation event", () => {
		const detector = new KeyboardDetector();
		detector.measure(viewport(900), false, true);
		detector.measure(viewport(900), true, true, true);
		expect(detector.measure(viewport(390, { width: 900 }), true, true)).toBe(false);
		expect(detector.measure(viewport(270, { width: 900 }), true, true)).toBe(true);
	});
});

describe("terminal toolbar input", () => {
	it("converts only single ASCII letters, preserving pasted and composed text", () => {
		for (let code = 65; code <= 90; code++) {
			expect(controlInput(String.fromCharCode(code))).toBe(String.fromCharCode(code - 64));
			expect(controlInput(String.fromCharCode(code + 32))).toBe(String.fromCharCode(code - 64));
		}
		for (const value of ["hello", "é", "👋", "\x1b[A", "1", "", "a\n"]) expect(controlInput(value)).toBe(value);
	});
	it("encodes each arrow in normal and application cursor modes", () => {
		for (const direction of ["A", "B", "C", "D"] as const) {
			expect(arrowInput(direction, false)).toBe(`\x1b[${direction}`);
			expect(arrowInput(direction, true)).toBe(`\x1bO${direction}`);
		}
	});
});
