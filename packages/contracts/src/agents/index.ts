import { z } from "zod";

import type { AgentOptions, AgentSettings } from "./types.ts";
export const agentStatusSchema = z.enum([
	"creating",
	"idle",
	"running",
	"waiting",
	"completed",
	"interrupted",
	"failed",
	"uncertain",
]);
export const createAgentSchema = z.strictObject({ title: z.string().trim().min(1).max(120) });
export const agentSettingsSchema = z.strictObject({
	model: z.string().min(1).max(256).optional(),
	reasoningEffort: z.string().min(1).max(256).optional(),
	permissions: z.enum(["ask", "approve-for-me", "full-access"]).optional(),
});
export const agentMessageSchema = agentSettingsSchema.extend({ text: z.string().trim().min(1).max(8000) });
export const agentOptionsSchema = z.strictObject({
	models: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(256),
				name: z.string().max(256),
				isDefault: z.boolean(),
				supportedReasoningEfforts: z
					.array(
						z.strictObject({
							reasoningEffort: z.string().min(1).max(256),
							description: z.string().max(4000),
						}),
					)
					.optional(),
				defaultReasoningEffort: z.string().min(1).max(256).optional(),
			}),
		)
		.max(500),
	skills: z.array(z.strictObject({ name: z.string().min(1).max(256), description: z.string().max(4000) })).max(500),
	defaultModel: agentSettingsSchema.shape.model,
	defaultReasoningEffort: agentSettingsSchema.shape.reasoningEffort,
	supportsAutoReview: z.literal(false).optional(),
});

export const resolveAgentSettings = (options: AgentOptions, settings: AgentSettings) => {
	const model = settings.model
		? options.models.find((entry) => entry.id === settings.model)
		: (options.models.find((entry) => entry.id === options.defaultModel)
			?? options.models.find((entry) => entry.isDefault));
	const supportsEffort = (effort: string) =>
		model?.supportedReasoningEfforts?.some((entry) => entry.reasoningEffort === effort) ?? false;
	const inherited = options.defaultReasoningEffort;
	return {
		model,
		reasoningEffort:
			settings.reasoningEffort
			?? (inherited && supportsEffort(inherited) ? inherited : model?.defaultReasoningEffort),
		supported:
			(!settings.model || !!model)
			&& (!settings.reasoningEffort || supportsEffort(settings.reasoningEffort))
			&& (settings.permissions !== "approve-for-me" || options.supportsAutoReview !== false),
	};
};
export const agentFilesSchema = z.array(z.string().min(1).max(4096)).max(100);
export const agentReplySchema = z.strictObject({
	requestId: z.string().min(1).max(256),
	decision: z.enum(["accept", "decline"]).optional(),
	answers: z.record(z.string().max(256), z.string().min(1).max(4000)).optional(),
});
export const agentThreadSchema = agentSettingsSchema.extend({
	id: z.uuid(),
	projectId: z.uuid(),
	workspaceId: z.uuid(),
	title: z.string().min(1).max(120),
	createdAt: z.iso.datetime(),
	status: agentStatusSchema,
	turnId: z.string().min(1).max(256).optional(),
});
export const agentThreadsSchema = z.array(agentThreadSchema);
export const agentItemSchema = z.strictObject({
	id: z.string().min(1).max(256),
	role: z.enum(["user", "assistant", "activity"]),
	kind: z.literal("plan").optional(),
	text: z.string().max(32000),
	title: z.string().max(256).optional(),
	status: z.enum(["running", "completed", "failed", "interrupted"]).optional(),
});
export const agentRequestSchema = z.strictObject({
	id: z.string().min(1).max(256),
	kind: z.enum(["command", "file", "input"]),
	description: z.string().max(8000),
	questions: z
		.array(
			z.strictObject({
				id: z.string().min(1).max(256),
				question: z.string().max(4000),
				secret: z.boolean(),
				options: z.array(z.string().max(1000)).max(20),
			}),
		)
		.max(10),
});
export const agentContextWindowSchema = z.strictObject({
	used: z.int().nonnegative(),
	max: z.int().positive(),
});
export const agentViewSchema = z.strictObject({
	thread: agentThreadSchema,
	items: z.array(agentItemSchema).max(500),
	requests: z.array(agentRequestSchema).max(32),
	truncated: z.boolean(),
	contextWindow: agentContextWindowSchema.optional(),
	turnFailure: z.enum(["provider-request", "context-window", "other"]).optional(),
});
export type {
	AgentStatus,
	AgentItem,
	AgentQuestion,
	AgentRequest,
	AgentThread,
	AgentView,
	AgentContextWindow,
	AgentTurnFailure,
	AgentReply,
	AgentSettings,
	AgentOptions,
} from "./types.ts";
