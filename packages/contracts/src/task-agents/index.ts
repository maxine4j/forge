import { z } from "zod";

const name = z.string().trim().min(1).max(120);
const model = z.string().trim().min(1).max(256);
const reasoningEffort = z.string().trim().min(1).max(256).optional();

const modelSelection = z.strictObject({
	providerId: z.uuid(),
	// Migrated selections may delegate to Codex's catalog default.
	model: model.optional(),
	reasoningEffort,
});

export const taskAgentInputSchema = z.strictObject({
	name,
	models: z.array(modelSelection).min(1),
});

export const taskAgentSchema = taskAgentInputSchema.extend({
	id: z.uuid(),
	retired: z.boolean(),
});

export const taskAgentsSchema = z.array(taskAgentSchema);
export type TaskAgentInput = z.infer<typeof taskAgentInputSchema>;
export type TaskAgent = z.infer<typeof taskAgentSchema>;
export type TaskAgentModel = z.infer<typeof modelSelection>;
