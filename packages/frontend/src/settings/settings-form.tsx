import { forgeSettingsSchema, type ForgeSettings } from "@forge/contracts/settings";
import { useEffect, useState, type FormEvent } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";

export const ForgeSettingsForm = ({ api }: { api: IWorkspaceApi }) => {
	const [draft, setDraft] = useState<ForgeSettings>();
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

	const change = (field: keyof ForgeSettings, value: string) => {
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
					? "Check the Git name, email and instruction lengths."
					: "Provide both a Git name and email, or leave both blank.",
			);
			return;
		}
		setError("");
		setSaving(true);
		try {
			setDraft(await api.read("settings", forgeSettingsSchema, "PUT", parsed.data));
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
