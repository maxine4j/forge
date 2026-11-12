import { z } from "zod";

import { branchNameSchema } from "../repository.ts";

export const pipelineStateSchema = z.enum([
	"pending",
	"running",
	"succeeded",
	"failed",
	"skipped",
	"cancelled",
	"interrupted",
]);
export const pipelineInputSchema = z.strictObject({
	branch: branchNameSchema,
	// eslint-disable-next-line no-control-regex
	workflowPath: z.string().regex(/^\.github\/workflows\/[^/\\\x00-\x1f]+\.ya?ml$/u),
	event: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/u),
});
export const pipelineStepSchema = z.object({
	id: z.string(),
	name: z.string(),
	order: z.number(),
	phase: z.string(),
	state: pipelineStateSchema,
	startedAt: z.string().nullable(),
	finishedAt: z.string().nullable(),
});
export const pipelineJobSchema = z.object({
	id: z.string(),
	name: z.string(),
	matrix: z.record(z.string(), z.unknown()),
	state: pipelineStateSchema,
	startedAt: z.string().nullable(),
	finishedAt: z.string().nullable(),
	steps: z.array(pipelineStepSchema),
});
export const pipelineRunSchema = pipelineInputSchema.extend({
	id: z.uuid(),
	projectId: z.uuid(),
	commit: z.string().regex(/^[a-f0-9]{40}$/u),
	workflowName: z.string(),
	state: pipelineStateSchema,
	createdAt: z.string(),
	startedAt: z.string().nullable(),
	finishedAt: z.string().nullable(),
	failure: z.string().nullable(),
	jobs: z.array(pipelineJobSchema),
});
export const pipelineDiscoverySchema = z.object({
	commit: z.string(),
	workflows: z.array(
		z.object({
			path: z.string(),
			name: z.string(),
			events: z.array(z.string()),
			messages: z.array(z.string()),
		}),
	),
});
export const pipelineRunSummarySchema = pipelineRunSchema.omit({ jobs: true });
export const pipelineHistorySchema = z.object({ runs: z.array(pipelineRunSummarySchema), hasMore: z.boolean() });
export type PipelineRun = z.infer<typeof pipelineRunSchema>;
export type PipelineRunSummary = z.infer<typeof pipelineRunSummarySchema>;
export type PipelineJob = z.infer<typeof pipelineJobSchema>;
export type PipelineInput = z.infer<typeof pipelineInputSchema>;
export type PipelineDiscovery = z.infer<typeof pipelineDiscoverySchema>;
