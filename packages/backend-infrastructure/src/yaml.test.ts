import { expect, test } from "vitest";

import { parseYaml, stringifyYaml, YamlError } from "./yaml.ts";

test.each(["secret: [private-token", "secret: private-token\nsecret: duplicate", "!private-token { secret: value }"])(
	"rejects malformed or warning-producing YAML without source excerpts",
	(source) => {
		try {
			parseYaml(source, "input.yaml");
			throw new Error("Expected parser rejection");
		} catch (error) {
			expect(error).toBeInstanceOf(YamlError);
			expect(String(error)).not.toContain("private-token");
			expect((error as YamlError).location).toMatch(/^input\.yaml(?::\d+:\d+)?$/);
		}
	},
);

test("stringifies and parses plain state values", () => {
	const value = { version: 1, endpoints: [{ public: false, address: "127.0.0.1" }] };
	expect(parseYaml(stringifyYaml(value), "state.yaml")).toEqual(value);
});
