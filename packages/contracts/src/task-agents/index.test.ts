import { expect, test } from "vitest";

import { agentAvatarColours, taskAgentInputSchema, taskAgentSchema } from "./index.ts";

test("agent inputs trim names and models and reject unknown fields", () => {
	const providerId = "123e4567-e89b-42d3-a456-426614174001";
	expect(taskAgentInputSchema.parse({ name: " Planner ", models: [{ providerId, model: " model " }] })).toEqual({
		name: "Planner",
		models: [{ providerId, model: "model" }],
	});
	for (const input of [
		{ name: " ", models: [{ providerId, model: "model" }] },
		{ name: "Planner", models: [] },
		{ name: "Planner", models: [{ providerId, model: " " }] },
		{ name: "Planner", models: [{ providerId, model: "model" }], retired: false },
		...[0, 1.5, "2", Number.MAX_SAFE_INTEGER + 1].map((maxConcurrentTickets) => ({
			name: "Planner",
			models: [{ providerId, model: "model" }],
			maxConcurrentTickets,
		})),
	])
		expect(taskAgentInputSchema.safeParse(input).success).toBe(false);
	expect(
		taskAgentSchema.parse({ id: providerId, name: "Migrated", models: [{ providerId }], retired: false })
			.maxConcurrentTickets,
	).toBe(1);
	expect(
		taskAgentInputSchema.parse({ name: "Planner", models: [{ providerId }], maxConcurrentTickets: null })
			.maxConcurrentTickets,
	).toBeNull();
});

test("legacy agents get a stable preset and inputs accept only the twelve preset colours", () => {
	const legacy = {
		id: "123e4567-e89b-42d3-a456-426614174001",
		name: "Migrated",
		models: [{ providerId: "123e4567-e89b-42d3-a456-426614174002" }],
		retired: false,
	};
	expect(new Set(agentAvatarColours).size).toBe(12);
	const saved = taskAgentSchema.parse(legacy);
	expect(agentAvatarColours).toContain(saved.avatarColour);
	expect(taskAgentSchema.parse(legacy).avatarColour).toBe(saved.avatarColour);
	expect(taskAgentSchema.parse({ ...legacy, avatarColour: "Mint" }).avatarColour).toBe("Mint");
	expect(saved.avatarSymbol).toBe("Robot");
	expect(taskAgentSchema.parse({ ...legacy, avatarSymbol: "Apple" }).avatarSymbol).toBe("Apple");
	expect(
		taskAgentInputSchema.safeParse({ name: legacy.name, models: legacy.models, avatarSymbol: "unknown" }).success,
	).toBe(false);
	expect(
		taskAgentInputSchema.safeParse({ name: legacy.name, models: legacy.models, avatarColour: "red" }).success,
	).toBe(false);
});
