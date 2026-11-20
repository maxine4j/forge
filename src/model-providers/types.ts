import { inferenceProviderSchema } from "@forge/contracts/settings";
import { z } from "zod";

/** Internal routing; public records expose only provider identity. */
export const providerSnapshotSchema = z.object({
	providerId: z.uuid().optional(),
	providerName: z.string().optional(),
	configuration: inferenceProviderSchema,
});
export type ModelProviderSnapshot = z.infer<typeof providerSnapshotSchema>;
