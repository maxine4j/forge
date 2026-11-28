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
});
