import { z } from "zod";

const instructions = z
	.string()
	.max(4000)
	.refine((value) => !value.includes("\0"));

// Frankfurter fiat currencies supported by Forge's billing selector.
export const billingCurrencies = [
	"AUD",
	"USD",
	"EUR",
	"GBP",
	"CAD",
	"NZD",
	"JPY",
	"CHF",
	"CNY",
	"HKD",
	"SGD",
	"INR",
	"BRL",
	"MXN",
	"ZAR",
	"KRW",
	"SEK",
	"NOK",
	"DKK",
	"PLN",
	"CZK",
	"HUF",
	"RON",
	"TRY",
	"IDR",
	"ILS",
	"MYR",
	"PHP",
	"THB",
	"ISK",
] as const;

export const forgeSettingsSchema = z
	.strictObject({
		localCurrency: z.enum(billingCurrencies),
		monthlyPlanLocal: z.number().nonnegative(),
		planningInstructions: instructions,
		implementationInstructions: instructions,
		defaultAgentModel: z.string().min(1).max(256).optional(),
		defaultAgentReasoningEffort: z.string().min(1).max(256).optional(),
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
	localCurrency: "AUD",
	monthlyPlanLocal: 30,
	planningInstructions: "",
	implementationInstructions: "",
	gitName: "",
	gitEmail: "",
};
