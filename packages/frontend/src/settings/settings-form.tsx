import { agentOptionsSchema, type AgentOptions } from "@forge/contracts/agents";
import { billingCurrencies, forgeSettingsSchema, type ForgeSettings } from "@forge/contracts/settings";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { ExecutionSettings } from "../agents/execution-settings.tsx";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { Dropdown, DropdownOption } from "../dropdown.tsx";
import { useErrorState, useToast } from "../toasts/toasts.tsx";

const currencyFlags: Partial<Record<ForgeSettings["localCurrency"], string>> = {
	AUD: "🇦🇺",
	USD: "🇺🇸",
	EUR: "🇪🇺",
	GBP: "🇬🇧",
	CAD: "🇨🇦",
	NZD: "🇳🇿",
	JPY: "🇯🇵",
	CHF: "🇨🇭",
	CNY: "🇨🇳",
	HKD: "🇭🇰",
	SGD: "🇸🇬",
	INR: "🇮🇳",
	BRL: "🇧🇷",
	MXN: "🇲🇽",
	ZAR: "🇿🇦",
	KRW: "🇰🇷",
	SEK: "🇸🇪",
	NOK: "🇳🇴",
	DKK: "🇩🇰",
	PLN: "🇵🇱",
	CZK: "🇨🇿",
	HUF: "🇭🇺",
	RON: "🇷🇴",
	TRY: "🇹🇷",
	IDR: "🇮🇩",
	ILS: "🇮🇱",
	MYR: "🇲🇾",
	PHP: "🇵🇭",
	THB: "🇹🇭",
	ISK: "🇮🇸",
};

export const ForgeSettingsForm = ({
	api,
	defaultsSaved,
	githubAccount,
	chatgptAccount,
}: {
	api: IWorkspaceApi;
	defaultsSaved: () => void;
	githubAccount: ReactNode;
	chatgptAccount: ReactNode;
}) => {
	const [draft, setDraft] = useState<ForgeSettings>();
	const [options, setOptions] = useState<AgentOptions>();
	const [optionsError, setOptionsError] = useState(false);
	const { notify } = useToast();
	const [optionsAttempt, setOptionsAttempt] = useState(0);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useErrorState();
	const [saved, setSaved] = useState(false);

	useEffect(() => {
		let active = true;
		void api.read("settings", forgeSettingsSchema).then(
			(settings) => {
				if (active) setDraft(settings);
			},
			() => {
				if (active) setError("Could not load Forge settings.");
			},
		);
		return () => {
			active = false;
		};
	}, [api, loadAttempt, setError]);

	useEffect(() => {
		let active = true;
		void api.read("settings/model-options", agentOptionsSchema).then(
			(value) => {
				if (active) setOptions(value);
			},
			() => {
				if (active) {
					setOptionsError(true);
					notify("Could not load model options.");
				}
			},
		);
		return () => {
			active = false;
		};
	}, [api, optionsAttempt, notify]);

	const change = (field: keyof ForgeSettings, value: string | number | undefined) => {
		setDraft((current) => current && { ...current, [field]: value });
		setError("");
		setSaved(false);
	};

	const save = async (event: FormEvent) => {
		event.preventDefault();
		if (saving) return;
		setSaved(false);
		const parsed = forgeSettingsSchema.safeParse(draft);
		if (!parsed.success) {
			const providerIssue = parsed.error.issues.find(({ path }) => path.at(0) === "inferenceProvider");
			const invalidEndpoint = parsed.error.issues.some(({ path }) => path.at(0) === "ollamaEndpoint");
			const invalidModel = parsed.error.issues.some(({ path }) => path.at(0) === "ollamaModel");
			setError(
				invalidEndpoint
					? "Enter an absolute HTTP or HTTPS Ollama endpoint without credentials, a query, or a fragment."
					: invalidModel
						? "Enter an Ollama model tag without spaces."
						: providerIssue
							? providerIssue.message
							: Boolean(draft?.gitName.trim()) === Boolean(draft?.gitEmail.trim())
								? "Check cost tracking values, Git identity and instruction lengths."
								: "Provide both a Git name and email, or leave both blank.",
			);
			return;
		}
		setError("");
		setSaving(true);
		try {
			setDraft(await api.read("settings", forgeSettingsSchema, "PUT", parsed.data));
			defaultsSaved();
			setSaved(true);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Could not save Forge settings.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<section className='forge-settings' aria-labelledby='forge-settings-heading'>
			<h2 id='forge-settings-heading'>Forge settings</h2>
			{draft ? (
				<form onSubmit={(event) => void save(event)}>
					<fieldset disabled={saving}>
						<legend>Cost tracking</legend>
						<div className='forge-settings-fields'>
							<label>
								Local currency
								<Dropdown
									aria-label='Local currency'
									className='forge-currency-select'
									value={draft.localCurrency}
									onChange={(value) => change("localCurrency", value)}
								>
									{billingCurrencies.map((currency) => (
										<DropdownOption
											key={currency}
											value={currency}
											matchingLabel={currency}
											icon={currencyFlags[currency]}
										>
											{currency}
										</DropdownOption>
									))}
								</Dropdown>
							</label>
							<label>
								Monthly plan price
								<input
									type='number'
									min='0'
									step='any'
									required
									value={draft.monthlyPlanLocal}
									onChange={(event) => change("monthlyPlanLocal", event.target.valueAsNumber)}
								/>
							</label>
						</div>
						<p>Applies to future turns. Historical costs keep their saved prices and exchange rates.</p>
					</fieldset>
					<fieldset disabled={saving}>
						<legend>Inference provider</legend>
						{chatgptAccount}
						<label>
							Provider for new agents
							<Dropdown
								aria-label='Provider for new agents'
								value={draft.inferenceProvider}
								onChange={(value) => change("inferenceProvider", value)}
							>
								<DropdownOption value='openai'>OpenAI</DropdownOption>
								<DropdownOption value='ollama'>Ollama</DropdownOption>
							</Dropdown>
						</label>
						<div className='forge-settings-fields'>
							<label>
								Ollama endpoint
								<input
									value={draft.ollamaEndpoint ?? ""}
									maxLength={2048}
									placeholder='http://ollama.internal:11434/v1'
									onChange={(event) => change("ollamaEndpoint", event.target.value || undefined)}
								/>
							</label>
							<label>
								Ollama model
								<input
									value={draft.ollamaModel ?? ""}
									maxLength={256}
									onChange={(event) => change("ollamaModel", event.target.value || undefined)}
								/>
							</label>
						</div>
						<p>Use the Responses API base URL ending in /v1.</p>
						<h3>OpenAI defaults</h3>
						<p>Apply to OpenAI tickets and chats that use Default on their next turn.</p>
						<ExecutionSettings
							configureDefaults
							options={options}
							settings={{
								model: draft.defaultAgentModel,
								reasoningEffort: draft.defaultAgentReasoningEffort,
							}}
							change={({ model, reasoningEffort }) => {
								setDraft({
									...draft,
									defaultAgentModel: model,
									defaultAgentReasoningEffort: reasoningEffort,
								});
								setError("");
								setSaved(false);
							}}
						/>
						{optionsError && (
							<button
								type='button'
								onClick={() => {
									setOptionsError(false);
									setOptionsAttempt((value) => value + 1);
								}}
							>
								Retry loading models
							</button>
						)}
					</fieldset>
					<fieldset disabled={saving}>
						<legend>Ticket agents</legend>
						<p>Instructions apply when a planning or implementation conversation starts.</p>
						<label>
							Planning instructions
							<textarea
								maxLength={4000}
								value={draft.planningInstructions}
								onChange={(event) => change("planningInstructions", event.target.value)}
							/>
						</label>
						<label>
							Implementation instructions
							<textarea
								maxLength={4000}
								value={draft.implementationInstructions}
								onChange={(event) => change("implementationInstructions", event.target.value)}
							/>
						</label>
					</fieldset>
					<fieldset disabled={saving}>
						<legend>Version control upstream</legend>
						{githubAccount}
						<p>Applies to commits across the Forge container. Leave both fields blank to clear it.</p>
						<div className='forge-settings-fields'>
							<label>
								Git name
								<input
									maxLength={120}
									value={draft.gitName}
									onChange={(event) => change("gitName", event.target.value)}
								/>
							</label>
							<label>
								Git email
								<input
									inputMode='email'
									maxLength={254}
									value={draft.gitEmail}
									onChange={(event) => change("gitEmail", event.target.value)}
								/>
							</label>
						</div>
					</fieldset>
					<div className='forge-settings-actions'>
						<button className='primary' type='submit' disabled={saving}>
							{saving ? "Saving…" : "Save settings"}
						</button>
						{saved && <p role='status'>Settings saved.</p>}
					</div>
				</form>
			) : (
				<>
					<div className='account-grid'>
						{chatgptAccount}
						{githubAccount}
					</div>
					{error ? (
						<button
							type='button'
							onClick={() => {
								setError("");
								setLoadAttempt((value) => value + 1);
							}}
						>
							Retry loading settings
						</button>
					) : (
						<p role='status'>Loading settings…</p>
					)}
				</>
			)}
		</section>
	);
};
