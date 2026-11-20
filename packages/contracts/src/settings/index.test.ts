import { expect, test } from "vitest";

import { modelProviderInputSchema } from "../model-providers/index.ts";
import { defaultForgeSettings, forgeSettingsSchema } from "./index.ts";

test("public settings exclude inference routing and model defaults", () => {
	expect(forgeSettingsSchema.parse(defaultForgeSettings)).toEqual(defaultForgeSettings);
	for (const update of [
		{ inferenceProvider: "openai" },
		{ ollamaEndpoint: "http://ollama/v1" },
		{ defaultAgentModel: "model" },
	])
		expect(forgeSettingsSchema.safeParse({ ...defaultForgeSettings, ...update }).success).toBe(false);
});

test.each([
	"/v1",
	"https:ollama.internal/v1",
	"ftp://ollama.internal/v1",
	"http://user@ollama.internal/v1",
	"http://@ollama.internal/v1",
	"http://ollama.internal/v1?",
	"http://ollama.internal/v1#",
	"http://ollama.internal/v1?key=x",
	`http://ollama.internal/${"x".repeat(2048)}`,
])("rejects invalid Ollama endpoint %s", (ollamaEndpoint) => {
	expect(
		modelProviderInputSchema.safeParse({ name: "Local", kind: "ollama", endpoint: ollamaEndpoint, model: "local" })
			.success,
	).toBe(false);
});

test("Forge settings accept multiline instructions and normalize Git identity", () => {
	expect(forgeSettingsSchema.parse(defaultForgeSettings)).toEqual(defaultForgeSettings);
	expect(
		forgeSettingsSchema.parse({
			...defaultForgeSettings,
			localCurrency: "AUD",
			monthlyPlanLocal: 30,
			planningInstructions: "Check migrations.\nInclude rollback steps.",
			gitName: "  Forge Developer  ",
			gitEmail: " forge@localhost ",
		}),
	).toEqual({
		...defaultForgeSettings,
		localCurrency: "AUD",
		monthlyPlanLocal: 30,
		planningInstructions: "Check migrations.\nInclude rollback steps.",
		gitName: "Forge Developer",
		gitEmail: "forge@localhost",
	});
});

test("Forge settings require a complete Git identity and bound instructions", () => {
	for (const update of [
		{ localCurrency: "XYZ" },
		{ localCurrency: "aud" },
		{ monthlyPlanLocal: -1 },
		{ monthlyPlanLocal: Infinity },
		{ monthlyPlanLocal: NaN },
		{ gitName: "Forge" },
		{ gitEmail: "forge@example.com" },
		{ gitName: "Forge\nDeveloper", gitEmail: "forge@example.com" },
		{ gitName: "Forge", gitEmail: "invalid" },
		{ gitName: "Forge", gitEmail: "x@example.com> <y@example.com" },
		{ localCurrency: "AUD", monthlyPlanLocal: 30, planningInstructions: "x".repeat(4001) },
		{ implementationInstructions: "x".repeat(4001) },
		{ localCurrency: "AUD", monthlyPlanLocal: 30, planningInstructions: "Invalid\0text" },
	]) {
		expect(forgeSettingsSchema.safeParse({ ...defaultForgeSettings, ...update }).success).toBe(false);
	}
});
