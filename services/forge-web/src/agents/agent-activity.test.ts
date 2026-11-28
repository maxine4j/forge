import { describe, expect, it } from "vitest";

import { parseJsonObject } from "./agent-activity";

describe("JSON chat payloads", () => {
	it("preserves bare and fenced payloads", () => {
		const payload = '{\n  "n": 1e2\n}';
		expect(parseJsonObject(` ${payload} `)?.payload).toBe(` ${payload} `);
		expect(parseJsonObject(`\n\`\`\`json\n${payload}\n\`\`\`\n`)?.payload).toBe(payload);
	});
	it.each(["{", 'before {"a":1}', "```json\n{}\n```\n```json\n{}\n```", "[]", "null", "42", '"x"'])(
		"rejects %s",
		(text) => {
			expect(parseJsonObject(text)).toBeUndefined();
		},
	);
	it("retains nested values and escaped text without changing the copy payload", () => {
		const payload = '{"nested":{"items":[null,true,0,"<script>"]},"escaped":"a\\nb"}';
		expect(parseJsonObject(payload)).toEqual({
			value: { nested: { items: [null, true, 0, "<script>"] }, escaped: "a\nb" },
			payload,
		});
	});

	it("accepts CRLF fenced objects and rejects truncated fenced JSON", () => {
		expect(parseJsonObject('```json\r\n{"ok":true}\r\n```')?.value).toEqual({ ok: true });
		expect(parseJsonObject('```json\n{"ok":true')).toBeUndefined();
	});
});
