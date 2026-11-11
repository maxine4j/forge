import { z } from "zod";
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
	permissions: z.enum(["ask", "approve-for-me", "full-access"]).optional(),
});
export const agentMessageSchema = agentSettingsSchema.extend({ text: z.string().trim().min(1).max(8000) });
export const agentOptionsSchema = z.strictObject({
	models: z
		.array(z.strictObject({ id: z.string().min(1).max(256), name: z.string().max(256), isDefault: z.boolean() }))
		.max(500),
	skills: z.array(z.strictObject({ name: z.string().min(1).max(256), description: z.string().max(4000) })).max(500),
});
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
export const agentViewSchema = z.strictObject({
	thread: agentThreadSchema,
	items: z.array(agentItemSchema).max(500),
	requests: z.array(agentRequestSchema).max(32),
	truncated: z.boolean(),
});
export type {
	AgentStatus,
	AgentItem,
	AgentQuestion,
	AgentRequest,
	AgentThread,
	AgentView,
	AgentReply,
	AgentSettings,
	AgentOptions,
} from "./types.ts";
