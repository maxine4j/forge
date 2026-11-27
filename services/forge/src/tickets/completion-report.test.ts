import { describe, expect, it } from "vitest";

import { parseCompletionReport } from "./completion-report.ts";

describe("parseCompletionReport", () => {
	it("accepts and trims valid reports", () => {
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
			'```json\n{"status":"complete"}\n```',
			'{"status":"complete","remaining":"tests"}',
			'{"status":"incomplete"}',
			'{"status":"incomplete","remaining":" "}',
			'{"status":"complete","extra":true}',
			JSON.stringify({ status: "complete", summary: "x".repeat(2001) }),
		])
			expect(parseCompletionReport(answer)).toBeUndefined();
	});
	it("allows handover only on incomplete checkpoint reports", () => {
		const answer = '{"status":"incomplete","remaining":"tests","handover":" notes "}';
		expect(parseCompletionReport(answer)).toBeUndefined();
		expect(parseCompletionReport(answer, true)).toEqual({
			status: "incomplete",
			remaining: "tests",
			handover: "notes",
		});
		expect(
			parseCompletionReport('{"status":"incomplete","remaining":"tests","handover":" "}', true),
		).toBeUndefined();
	});
});
