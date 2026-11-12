import { z } from "zod";

export const dockerIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const dockerStatsSchema = z.object({
	cpu: z.string(),
	memory: z.string(),
	network: z.string(),
	block: z.string(),
	processes: z.string(),
});
export const dockerContainerSchema = z.object({
	id: dockerIdSchema,
	name: z.string(),
	image: z.string(),
	status: z.string(),
	ports: z.string(),
	stats: dockerStatsSchema.nullable(),
});
export const dockerResourcesSchema = z.object({
	containers: z.array(z.string()),
	images: z.array(z.string()),
	volumes: z.array(z.string()),
	networks: z.array(z.string()),
	buildCache: z.array(z.string()),
});
export const dockerOperationSchema = z.object({
	id: z.string().uuid(),
	target: z.string(),
	status: z.enum(["running", "completed", "partial"]),
	progress: z.string(),
	failures: z.array(z.string()),
	retained: z.array(z.string()),
	remaining: dockerResourcesSchema.nullable(),
});
export const dockerOverviewSchema = z.object({
	available: z.boolean(),
	containers: z.array(dockerContainerSchema),
	statisticsAt: z.string().nullable(),
	statisticsStale: z.boolean(),
	operation: dockerOperationSchema.nullable(),
});
export type DockerStats = z.infer<typeof dockerStatsSchema>;
export type DockerContainer = z.infer<typeof dockerContainerSchema>;
export type DockerResources = z.infer<typeof dockerResourcesSchema>;
export type DockerOperation = z.infer<typeof dockerOperationSchema>;
export type DockerOverview = z.infer<typeof dockerOverviewSchema>;
