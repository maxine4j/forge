import { z } from "zod";

const instructions = z
	.string()
	.max(4000)
	.refine((value) => !value.includes("\0"));

export const forgeSettingsSchema = z
	.strictObject({
		planningInstructions: instructions,
		implementationInstructions: instructions,
		gitName: z
			.string()
			.trim()
			.max(120)
			.regex(/^[^\p{Cc}<>]*$/u),
		gitEmail: z
			.string()
			.trim()
			.max(254)
			.regex(/^(?:[^\s\p{Cc}<>@]+@[^\s\p{Cc}<>@]+)?$/u),
	})
	.refine(({ gitName, gitEmail }) => Boolean(gitName) === Boolean(gitEmail), {
		message: "Provide both a Git name and email, or leave both blank.",
	});

export type ForgeSettings = z.infer<typeof forgeSettingsSchema>;

export interface GitIdentity {
	name: string;
	email: string;
}

export const defaultForgeSettings: Readonly<ForgeSettings> = {
	planningInstructions: "",
	implementationInstructions: "",
	gitName: "",
	gitEmail: "",
};
