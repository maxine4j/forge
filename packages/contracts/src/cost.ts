import { z } from "zod";

const count = z.int().nonnegative();
const amount = z.number().nonnegative();
const tokens = z.object({ input: count, cached: count, output: count });
const summary = tokens.extend({ turns: count });
export const costPhaseSchema = z.enum(["planning", "implementation", "review", "rebase", "chat"]);
export const weeklyObservationSchema = z.object({
	bucketId: z.string(),
	bucket: z.string(),
	observedAt: z.iso.datetime(),
	usedPercent: z.number().min(0).max(100),
	minutes: z.literal(10080),
	resetsAt: z.iso.datetime(),
});
export const weeklyBudgetSchema = z.object({
	defaultBucketId: z.string().optional(),
	buckets: z.array(
		z.object({
			bucketId: z.string(),
			bucket: z.string(),
			observations: z.array(weeklyObservationSchema),
			remainingPercent: z.number(),
			lastObservedAt: z.iso.datetime(),
			resetsAt: z.iso.datetime(),
			fresh: z.boolean(),
			additionalTickets: count.optional(),
			unavailable: z.enum(["learning", "stale", "reset-passed"]).optional(),
			completedTickets: count,
			coverageHours: amount,
			consumption: amount,
			periodStart: z.iso.datetime().optional(),
			periodEnd: z.iso.datetime().optional(),
		}),
	),
});
export type WeeklyObservation = z.infer<typeof weeklyObservationSchema>;
export type WeeklyBudget = z.infer<typeof weeklyBudgetSchema>;
export const projectCostSchema = z.object({
	weeklyBudget: weeklyBudgetSchema.optional(),
	since: z.iso.datetime(),
	monthlyAud: amount,
	audPerUsd: amount.positive(),
	exchangeDate: z.iso.date(),
	totals: summary,
	phases: z.array(summary.extend({ phase: costPhaseSchema })),
	days: z.array(tokens.extend({ date: z.iso.date() })).max(30),
	tickets: z.array(
		summary.extend({
			id: z.string(),
			title: z.string(),
			archivedAt: z.iso.datetime().optional(),
			subscriptionAud: amount.optional(),
			apiAud: amount.optional(),
			untimedTurns: count,
			unpricedTurns: count,
		}),
	),
	limits: z
		.object({
			plan: z.string().optional(),
			windows: z.array(
				z.object({
					bucketId: z.string().optional(),
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
