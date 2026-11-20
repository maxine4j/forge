import { billingCurrencies, forgeSettingsSchema, type ForgeSettings } from "@forge/contracts/settings";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { Dropdown, DropdownOption } from "../dropdown.tsx";
import { useErrorState } from "../toasts/toasts.tsx";
import { ModelProviders } from "./model-providers.tsx";

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
	connectOpenAI,
}: {
	api: IWorkspaceApi;
	defaultsSaved: () => void;
	githubAccount: ReactNode;
	chatgptAccount: ReactNode;
	connectOpenAI: () => void;
}) => {
	const [draft, setDraft] = useState<ForgeSettings>();
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
			setError(
				Boolean(draft?.gitName.trim()) === Boolean(draft?.gitEmail.trim())
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
			<ModelProviders api={api} account={chatgptAccount} changed={defaultsSaved} connectOpenAI={connectOpenAI} />
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
					<div className='account-grid'>{githubAccount}</div>
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
