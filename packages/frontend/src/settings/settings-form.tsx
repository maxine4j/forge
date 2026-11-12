import { agentOptionsSchema, type AgentOptions } from "@forge/contracts/agents";
import { billingCurrencies, forgeSettingsSchema, type ForgeSettings } from "@forge/contracts/settings";
import { useEffect, useState, type FormEvent } from "react";

import { ExecutionSettings } from "../agents/execution-settings.tsx";
import type { IWorkspaceApi } from "../api/workspace-api.ts";

export const ForgeSettingsForm = ({ api, defaultsSaved }: { api: IWorkspaceApi; defaultsSaved: () => void }) => {
	const [draft, setDraft] = useState<ForgeSettings>();
	const [options, setOptions] = useState<AgentOptions>();
	const [optionsError, setOptionsError] = useState(false);
	const [optionsAttempt, setOptionsAttempt] = useState(0);
	const [loadAttempt, setLoadAttempt] = useState(0);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
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
	}, [api, loadAttempt]);

	useEffect(() => {
		let active = true;
		void api.read("settings/model-options", agentOptionsSchema).then(
			(value) => {
				if (active) setOptions(value);
			},
			() => {
				if (active) setOptionsError(true);
			},
		);
		return () => {
			active = false;
		};
	}, [api, optionsAttempt]);

	const change = (field: keyof ForgeSettings, value: string | number) => {
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
					? "Check billing values, Git identity and instruction lengths."
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
						<legend>Billing</legend>
						<label>
							Local currency
							<select
								value={draft.localCurrency}
								onChange={(event) => change("localCurrency", event.target.value)}
							>
								{billingCurrencies.map((currency) => (
									<option key={currency}>{currency}</option>
								))}
							</select>
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
						<p>Applies to future turns. Historical costs keep their saved prices and exchange rates.</p>
					</fieldset>
					<fieldset disabled={saving}>
						<legend>Agent defaults</legend>
						<p>Apply to tickets and chats that use Default on their next turn.</p>
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
						<legend>Git identity</legend>
						<p>Applies to commits across the Forge container. Leave both fields blank to clear it.</p>
						<div className='forge-git-fields'>
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
			) : error ? (
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
			{error && (
				<p role='alert' className='error'>
					{error}
				</p>
			)}
		</section>
	);
};
