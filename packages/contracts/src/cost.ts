import { z } from "zod";

const count = z.int().nonnegative();
const amount = z.number().nonnegative();
const tokens = z.object({ input: count, cached: count, output: count });
const summary = tokens.extend({ turns: count });
export const costPhaseSchema = z.enum(["planning", "implementation", "review", "rebase", "chat"]);
export const projectCostSchema = z.object({
	since: z.iso.datetime(),
	monthlyAud: amount,
	audPerUsd: amount.positive(),
	exchangeDate: z.iso.date(),
	totals: summary,
	phases: z.array(summary.extend({ phase: costPhaseSchema })),
	days: z.array(tokens.extend({ date: z.iso.date() })).max(30),
	tickets: z
		.array(
			summary.extend({
				id: z.string(),
				title: z.string(),
				subscriptionAud: amount.optional(),
				apiAud: amount.optional(),
				untimedTurns: count,
				unpricedTurns: count,
			}),
		)
		.max(1000),
	limits: z
		.object({
			plan: z.string().optional(),
			windows: z.array(
				z.object({
					bucket: z.string(),
					minutes: count.optional(),
					usedPercent: count,
					resetsAt: z.iso.datetime().optional(),
				}),
			),
		})
		.optional(),
});
export type ProjectCost = z.infer<typeof projectCostSchema>;
