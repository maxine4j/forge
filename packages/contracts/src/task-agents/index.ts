import { z } from "zod";

const name = z.string().trim().min(1).max(120);
const model = z.string().trim().min(1).max(256);
const reasoningEffort = z.string().trim().min(1).max(256).optional();

export const taskAgentInputSchema = z.strictObject({
	name,
	providerId: z.uuid(),
	model,
	reasoningEffort,
});

// Older configurations may delegate their model to Codex until the first dispatch.
export const taskAgentSchema = z.strictObject({
	id: z.uuid(),
	name,
	providerId: z.uuid(),
	model: model.optional(),
	reasoningEffort,
	retired: z.boolean(),
});

export const taskAgentsSchema = z.array(taskAgentSchema);
export type TaskAgentInput = z.infer<typeof taskAgentInputSchema>;
export type TaskAgent = z.infer<typeof taskAgentSchema>;
