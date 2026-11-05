import { z } from "zod";

export const terminalDimensionsSchema = z.strictObject({
	cols: z.number().int().min(2).max(500),
	rows: z.number().int().min(1).max(200),
});
export const terminalSessionSchema = z.strictObject({
	id: z.uuid(),
	workspaceId: z.uuid(),
	status: z.enum(["starting", "running", "exited", "closed", "lost"]),
	createdAt: z.iso.datetime(),
	endedAt: z.iso.datetime().optional(),
	exitCode: z.number().int().optional(),
	cols: terminalDimensionsSchema.shape.cols,
	rows: terminalDimensionsSchema.shape.rows,
});
export const terminalStatusSchema = z.strictObject({ session: terminalSessionSchema.optional() });
export const terminalClientMessageSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("input"), data: z.string().min(1).max(16384) }),
	terminalDimensionsSchema.extend({ type: z.literal("resize") }),
]);
export const terminalServerMessageSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("output"), sequence: z.number().int().positive(), data: z.string() }),
	z.strictObject({ type: z.literal("gap"), through: z.number().int().nonnegative() }),
	z.strictObject({ type: z.literal("status"), session: terminalSessionSchema }),
]);
export type { TerminalDimensions, TerminalSession, TerminalClientMessage, TerminalServerMessage } from "./types.ts";
