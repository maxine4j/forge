import { describe, expect, it } from "vitest";

import { capHandoffText, completionReportRequirements, parseCompletionReport } from "./completion-report.ts";

describe("parseCompletionReport", () => {
	it("accepts and trims valid reports", () => {
		expect(parseCompletionReport('{"status":"complete"}')).toEqual({ status: "complete" });
		expect(parseCompletionReport('{"status":"complete","summary":" done "}')).toEqual({
			status: "complete",
			summary: "done",
		});
		expect(parseCompletionReport('{"status":"incomplete","remaining":" tests "}')).toEqual({
			status: "incomplete",
			remaining: "tests",
		});
	});
	it("rejects prose, invalid fields and blank or oversized text", () => {
		for (const answer of [
			"not complete",
			'{"status":"complete"',
			'{"status":"complete"} {"status":"complete"}',
			'[{"status":"complete"}]',
			"null",
			'```json\n{"status":"complete"}\n```',
			'{"status":"complete","remaining":"tests"}',
			'{"status":"incomplete"}',
			'{"status":"incomplete","remaining":" "}',
			'{"status":"complete","extra":true}',
			'{"status":"complete","summary":false}',
			'{"status":"complete","summary":" "}',
			'{"status":"incomplete","remaining":3}',
			JSON.stringify({ status: "complete", summary: "x".repeat(2001) }),
		])
			expect(parseCompletionReport(answer)).toBeUndefined();
	});
	it("accepts handoff during work and checkpoint reporting", () => {
		const checkpoint = completionReportRequirements(true);
		const answer = '{"status":"handoff","handover":" notes "}';
		expect(parseCompletionReport(answer)).toEqual({ status: "handoff", handover: "notes" });
		expect(parseCompletionReport(answer, checkpoint)).toEqual({
			status: "handoff",
			handover: "notes",
		});
		expect(parseCompletionReport('{"status":"complete"}', checkpoint)).toEqual({ status: "complete" });
		for (const invalid of [
			'{"status":"incomplete","remaining":"tests"}',
			'{"status":"complete","handover":"notes"}',
			'{"status":"handoff","handover":"notes","summary":"extra"}',
			'{"status":"handoff","handover":" "}',
			'{"status":"handoff","handover":null}',
			'{"status":"handoff"}',
		])
			expect(parseCompletionReport(invalid, checkpoint)).toBeUndefined();
	});
	it.each([false, true])("requires and bounds a nonfinal completion summary (checkpoint=%s)", (checkpoint) => {
		const requirements = completionReportRequirements(checkpoint, true);
		for (const invalid of [
			'{"status":"complete"}',
			'{"status":"complete","summary":" "}',
			'{"status":"complete","summary":1}',
		])
			expect(parseCompletionReport(invalid, requirements)).toBeUndefined();
		expect(
			parseCompletionReport(JSON.stringify({ status: "complete", summary: "x".repeat(8100) }), requirements),
		).toEqual({ status: "complete", summary: "x".repeat(8000) });
	});
	it("bounds handoff text deterministically without splitting surrogate pairs", () => {
		const short = "x".repeat(7999);
		const limit = "x".repeat(8000);
		expect(capHandoffText(`  ${short}  `)).toBe(short);
		expect(capHandoffText(limit)).toBe(limit);
		expect(capHandoffText(`${limit}extra`)).toBe(limit);
		expect(capHandoffText(`${short} extra`)).toBe(short);
		expect(capHandoffText(`${short}😀`)).toBe(short);
		expect(capHandoffText(`${short.slice(1)}😀extra`)).toBe(`${short.slice(1)}😀`);
	});
});
