import type { AgentOptions, AgentSettings } from "@forge/contracts/agents";

export const ExecutionSettings = ({
	settings,
	options,
	change,
	disabled = false,
}: {
	settings: AgentSettings;
	options?: AgentOptions;
	change: (settings: AgentSettings) => void;
	disabled?: boolean;
}) => {
	const model = options?.models.find((value) => (settings.model ? value.id === settings.model : value.isDefault));
	return (
		<div className='agent-composer-settings'>
			<select
				aria-label='Model'
				value={settings.model ?? ""}
				disabled={disabled || !options}
				onChange={(event) => {
					const model = options?.models.find((value) =>
						event.target.value ? value.id === event.target.value : value.isDefault,
					);
					change({
						...settings,
						model: event.target.value || undefined,
						reasoningEffort: model?.supportedReasoningEfforts?.some(
							(value) => value.reasoningEffort === settings.reasoningEffort,
						)
							? settings.reasoningEffort
							: undefined,
					});
				}}
			>
				<option value=''>Default model</option>
				{settings.model && !options?.models.some((value) => value.id === settings.model) && (
					<option value={settings.model}>{settings.model}</option>
				)}
				{options?.models.map((value) => (
					<option key={value.id} value={value.id}>
						{value.name}
					</option>
				))}
			</select>
			<select
				aria-label='Thinking level'
				value={settings.reasoningEffort ?? ""}
				disabled={disabled || !options}
				onChange={(event) => change({ ...settings, reasoningEffort: event.target.value || undefined })}
			>
				<option value=''>
					Default thinking{model?.defaultReasoningEffort ? ` (${model.defaultReasoningEffort})` : ""}
				</option>
				{settings.reasoningEffort
					&& !model?.supportedReasoningEfforts?.some(
						(value) => value.reasoningEffort === settings.reasoningEffort,
					) && <option value={settings.reasoningEffort}>{settings.reasoningEffort}</option>}
				{model?.supportedReasoningEfforts?.map((value) => (
					<option key={value.reasoningEffort} value={value.reasoningEffort}>
						{value.reasoningEffort}
					</option>
				))}
			</select>
			<select
				aria-label='Permissions'
				value={settings.permissions ?? "ask"}
				disabled={disabled}
				onChange={(event) =>
					change({ ...settings, permissions: event.target.value as AgentSettings["permissions"] })
				}
			>
				<option value='ask'>Ask</option>
				<option value='approve-for-me'>Approve for me</option>
				<option value='full-access'>Full access</option>
			</select>
		</div>
	);
};
