import { z } from "zod";

export const minConcurrentAgents = 1;
export const maxConcurrentAgents = 10;
export const defaultConcurrentAgents = 3;

export const boardSettingsSchema = z.strictObject({
	dispatch: z.enum(["running", "paused", "stopped"]),
	maxAgents: z.int().min(minConcurrentAgents).max(maxConcurrentAgents),
});
export type BoardSettings = z.infer<typeof boardSettingsSchema>;

export const defaultBoardSettings: Readonly<BoardSettings> = {
	dispatch: "running",
	maxAgents: defaultConcurrentAgents,
};

export const boardSettingsUpdateSchema = boardSettingsSchema.partial().extend({
	dispatch: z.enum(["running", "paused"]).optional(),
});
export type BoardSettingsUpdate = z.infer<typeof boardSettingsUpdateSchema>;

export const boardStopSchema = z.strictObject({
	settings: boardSettingsSchema,
	requested: z.int().nonnegative(),
	recovered: z.int().nonnegative(),
	failed: z.int().nonnegative(),
});
export type BoardStop = z.infer<typeof boardStopSchema>;
