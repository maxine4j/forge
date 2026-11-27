import { z } from "zod";

import { inferenceProviderSchema } from "../settings/index.ts";

const name = z.string().trim().min(1).max(120);
const concurrentAgents = z.int().positive();
const compactionThresholdTokens = z.int().positive();
const comparisonModel = z.string().trim().min(1).max(256).optional();
const comparisonInput = z
	.string()
	.trim()
	.max(256)
	.transform((value) => value || undefined)
	.optional();
export const modelProviderPatchSchema = z.strictObject({
	name: name.optional(),
	kind: z.enum(["openai", "ollama"]).optional(),
	endpoint: z.string().optional(),
	comparisonModel: comparisonInput.nullable(),
	maxConcurrentAgents: concurrentAgents.optional(),
	compactionThresholdTokens: compactionThresholdTokens.nullable().optional(),
});
export const modelProviderInputSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		name,
		kind: z.literal("openai"),
		maxConcurrentAgents: concurrentAgents.default(1),
		compactionThresholdTokens: compactionThresholdTokens.optional(),
	}),
	z
		.strictObject({
			name,
			kind: z.literal("ollama"),
			endpoint: inferenceProviderSchema.options[1].shape.endpoint,
			comparisonModel: comparisonInput,
			maxConcurrentAgents: concurrentAgents.default(1),
			compactionThresholdTokens: compactionThresholdTokens.optional(),
		})
		.refine(
			(value) => URL.parse(value.endpoint)?.pathname.endsWith("/v1") ?? false,
			"Use a Responses API base URL ending in /v1.",
		),
]);
export const modelProviderSchema = z.object({
	id: z.uuid(),
	name,
	kind: z.enum(["openai", "ollama"]),
	endpoint: z.string().optional(),
	comparisonModel,
	retired: z.boolean(),
	maxConcurrentAgents: concurrentAgents.default(1),
	compactionThresholdTokens: compactionThresholdTokens.optional(),
	contextWindow: z.int().positive().optional(),
	supportedConcurrency: z.int().positive().optional(),
});
export const modelProvidersSchema = z.array(modelProviderSchema);
export const modelProviderHealthSchema = z.object({
	providerId: z.uuid(),
	status: z.enum(["healthy", "unhealthy", "usage-limits-reached"]),
});
export const modelProviderHealthListSchema = z.array(modelProviderHealthSchema);
export type ModelProviderHealth = z.infer<typeof modelProviderHealthSchema>;
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type ModelProviderInput = z.infer<typeof modelProviderInputSchema>;
