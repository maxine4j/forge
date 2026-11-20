import { z } from "zod";

import { inferenceProviderSchema } from "../settings/index.ts";

const name = z.string().trim().min(1).max(120);
const defaults = {
	defaultAgentModel: z.string().min(1).max(256).optional(),
	defaultAgentReasoningEffort: z.string().min(1).max(256).optional(),
};
export const modelProviderPatchSchema = z.strictObject({
	name: name.optional(),
	kind: z.enum(["openai", "ollama"]).optional(),
	endpoint: z.string().optional(),
	model: z.string().optional(),
	defaultAgentModel: defaults.defaultAgentModel.nullable(),
	defaultAgentReasoningEffort: defaults.defaultAgentReasoningEffort.nullable(),
});
export const modelProviderInputSchema = z.discriminatedUnion("kind", [
	z.strictObject({ name, kind: z.literal("openai"), ...defaults }),
	z
		.strictObject({ name, ...inferenceProviderSchema.options[1].shape })
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
	model: z.string().optional(),
	...defaults,
	retired: z.boolean(),
});
export const modelProvidersSchema = z.array(modelProviderSchema);
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type ModelProviderInput = z.infer<typeof modelProviderInputSchema>;
