import { expect, test } from "vitest";

import { AccessService } from "./access-service.ts";

test("only the configured PaaS identity is an actor; optional profile headers are irrelevant", () => {
	const access = new AccessService({ owner: "Owner", origin: "https://forge.example.com" });
	expect(access.authorize("OWNER", undefined, false)).toEqual({ username: "owner" });
	for (const username of [undefined, "", "other", ["owner"], "owner,other", "owner\n", "-owner", "a--b"]) {
		expect(() => access.authorize(username, undefined, false)).toThrow("Access denied");
	}
	expect(() => access.assertOwner({ username: "other" })).toThrow("Access denied");
});

test("mutations and live connections require the exact configured HTTPS origin", () => {
	const access = new AccessService({ owner: "owner", origin: "https://forge.example.com" });
	expect(access.authorize("owner", "https://forge.example.com", true)).toEqual({ username: "owner" });
	for (const origin of [
		undefined,
		"null",
		"https://evil.example.com",
		"https://forge.example.com/",
		"http://forge.example.com",
		["https://forge.example.com"],
	]) {
		expect(() => access.authorize("owner", origin, true)).toThrow("Access denied");
	}
});
