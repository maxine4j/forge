import { z } from "zod";

import { inferenceProviderSchema } from "../settings/index.ts";

const name = z.string().trim().min(1).max(120);
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
});
export const modelProviderInputSchema = z.discriminatedUnion("kind", [
	z.strictObject({ name, kind: z.literal("openai") }),
	z
		.strictObject({
			name,
			kind: z.literal("ollama"),
			endpoint: inferenceProviderSchema.options[1].shape.endpoint,
			comparisonModel: comparisonInput,
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
});
export const modelProvidersSchema = z.array(modelProviderSchema);
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type ModelProviderInput = z.infer<typeof modelProviderInputSchema>;
