import { z } from "zod";

export const boardSettingsSchema = z.strictObject({
	dispatch: z.enum(["running", "paused", "stopped"]),
});
export type BoardSettings = z.infer<typeof boardSettingsSchema>;

export const defaultBoardSettings: Readonly<BoardSettings> = {
	dispatch: "running",
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
