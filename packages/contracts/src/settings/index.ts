import { z } from "zod";

const instructions = z
	.string()
	.max(4000)
	.refine((value) => !value.includes("\0"));

const ollamaEndpoint = z
	.string()
	.trim()
	.max(2048)
	.refine((value) => {
		const authority = /^https?:\/\/([^/\\?#]+)/i.exec(value)?.at(1);
		if (!authority || authority.includes("@") || /[\s\p{Cc}\\?#]/u.test(value)) return false;
		const url = URL.parse(value);
		return !!url && !url.username && !url.password;
	}, "Enter an absolute HTTP or HTTPS URL without credentials, a query, or a fragment.");
const ollamaModel = z
	.string()
	.trim()
	.min(1)
	.max(256)
	.regex(/^[^\s\p{Cc}]+$/u);

export const inferenceProviderSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("openai") }),
	z.strictObject({ kind: z.literal("ollama"), endpoint: ollamaEndpoint, model: ollamaModel }),
]);
export type InferenceProvider = z.infer<typeof inferenceProviderSchema>;

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
		inferenceProvider: z.enum(["openai", "ollama"]).default("openai"),
		ollamaEndpoint: ollamaEndpoint.optional(),
		ollamaModel: ollamaModel.optional(),
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
	})
	.refine(
		({ inferenceProvider, ollamaEndpoint, ollamaModel }) =>
			inferenceProvider === "openai" || Boolean(ollamaEndpoint && ollamaModel),
		{
			path: ["inferenceProvider"],
			message: "Provide an Ollama endpoint and model tag.",
		},
	);

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
	inferenceProvider: "openai",
	gitName: "",
	gitEmail: "",
};
