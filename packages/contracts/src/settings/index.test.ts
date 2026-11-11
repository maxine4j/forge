import { expect, test } from "vitest";

import { defaultForgeSettings, forgeSettingsSchema } from "./index.ts";

test("Forge settings accept multiline instructions and normalize Git identity", () => {
	expect(forgeSettingsSchema.parse(defaultForgeSettings)).toEqual(defaultForgeSettings);
	expect(
		forgeSettingsSchema.parse({
			...defaultForgeSettings,
			planningInstructions: "Check migrations.\nInclude rollback steps.",
			gitName: "  Forge Developer  ",
			gitEmail: " forge@localhost ",
		}),
	).toEqual({
		...defaultForgeSettings,
		planningInstructions: "Check migrations.\nInclude rollback steps.",
		gitName: "Forge Developer",
		gitEmail: "forge@localhost",
	});
});

test("Forge settings require a complete Git identity and bound instructions", () => {
	for (const update of [
		{ gitName: "Forge" },
		{ gitEmail: "forge@example.com" },
		{ gitName: "Forge\nDeveloper", gitEmail: "forge@example.com" },
		{ gitName: "Forge", gitEmail: "invalid" },
		{ gitName: "Forge", gitEmail: "x@example.com> <y@example.com" },
		{ planningInstructions: "x".repeat(4001) },
		{ implementationInstructions: "x".repeat(4001) },
		{ planningInstructions: "Invalid\0text" },
	]) {
		expect(forgeSettingsSchema.safeParse({ ...defaultForgeSettings, ...update }).success).toBe(false);
	}
});
