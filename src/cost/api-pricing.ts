import type { TokenCounts } from "./types.ts";

// Standard USD per million text tokens. See https://developers.openai.com/api/docs/pricing
// and individual model pages for legacy models. Checked 2026-11-11.
const rates = new Map([
	["gpt-6-astra", { input: 10, cached: 1, output: 50 }],
	["gpt-6-sol", { input: 2, cached: 0.2, output: 10 }],
	["gpt-6.1-sol", { input: 2, cached: 0.1, output: 10 }],
	["gpt-6.1-terra", { input: 1, cached: 0.05, output: 5 }],
	["gpt-6-luna", { input: 0.1, cached: 0.01, output: 0.5 }],
	["gpt-5.6-sol", { input: 4, cached: 0.4, output: 20 }],
	["gpt-5.6-terra", { input: 2, cached: 0.2, output: 12 }],
	["gpt-5.5", { input: 5, cached: 0.5, output: 30 }],
	["gpt-5.4", { input: 2.5, cached: 0.25, output: 15 }],
	["gpt-5.4-mini", { input: 0.75, cached: 0.075, output: 4.5 }],
	["gpt-5.3-codex", { input: 1.75, cached: 0.175, output: 14 }],
]);

export const modelRates = (model?: string): TokenCounts | undefined =>
	model ? rates.get(model === "gpt-5.6" ? "gpt-5.6-sol" : model) : undefined;

export const apiCostUsd = (rate: TokenCounts | undefined, tokens: TokenCounts): number | undefined => {
	if (!rate) return undefined;
	return (
		((tokens.input - tokens.cached) * rate.input + tokens.cached * rate.cached + tokens.output * rate.output)
		/ 1_000_000
	);
};
