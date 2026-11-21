import { z } from "zod";

const name = z.string().trim().min(1).max(120);
const model = z.string().trim().min(1).max(256);
const reasoningEffort = z.string().trim().min(1).max(256).optional();

export const agentAvatarColours = [
	"Coral",
	"Rose",
	"Berry",
	"Violet",
	"Lavender",
	"Indigo",
	"Sky",
	"Teal",
	"Mint",
	"Lime",
	"Amber",
	"Peach",
] as const;
const avatarColourSchema = z.enum(agentAvatarColours);
export type AgentAvatarColour = z.infer<typeof avatarColourSchema>;
export const ticketAssigneeSchema = z.strictObject({ name, avatarColour: avatarColourSchema });
export type TicketAssignee = z.infer<typeof ticketAssigneeSchema>;

const modelSelection = z.strictObject({
	providerId: z.uuid(),
	// Migrated selections may delegate to Codex's catalog default.
	model: model.optional(),
	reasoningEffort,
});

export const taskAgentInputSchema = z.strictObject({
	name,
	models: z.array(modelSelection).min(1),
	maxConcurrentTickets: z.int().positive().optional(),
	avatarColour: avatarColourSchema.optional(),
});

export const taskAgentSchema = taskAgentInputSchema
	.extend({
		id: z.uuid(),
		retired: z.boolean(),
		maxConcurrentTickets: z.int().positive().default(1),
	})
	.transform((agent) => ({
		...agent,
		avatarColour:
			agent.avatarColour
			?? agentAvatarColours.at(Number.parseInt(agent.id.slice(0, 8), 16) % agentAvatarColours.length)!,
	}));

export const taskAgentsSchema = z.array(taskAgentSchema);
export type TaskAgentInput = z.infer<typeof taskAgentInputSchema>;
export type TaskAgent = z.infer<typeof taskAgentSchema>;
export type TaskAgentModel = z.infer<typeof modelSelection>;
