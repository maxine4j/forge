import { expect, test } from "vitest";

import { taskAgentInputSchema, taskAgentSchema } from "./index.ts";

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
});
