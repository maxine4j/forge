import { resolveAgentSettings, type AgentOptions, type AgentSettings } from "@forge/contracts/agents";
import { createContext, Fragment } from "react";

export const AgentOptionsRevision = createContext(0);

export const ExecutionSettings = ({
	settings,
	options,
	change,
	disabled = false,
	configureDefaults = false,
}: {
	settings: AgentSettings;
	options?: AgentOptions;
	change: (settings: AgentSettings) => void;
	disabled?: boolean;
	configureDefaults?: boolean;
}) => {
	const defaults = options && resolveAgentSettings(options, {});
	const effective = options && resolveAgentSettings(options, { model: settings.model });
	const model = effective?.model;
	const thinking = effective?.reasoningEffort;
	const Field = configureDefaults ? "label" : Fragment;
	return (
		<div className='agent-composer-settings'>
			<Field>
				{configureDefaults && "Default model"}
				<select
					aria-label={configureDefaults ? "Default model" : "Model"}
					value={settings.model ?? ""}
					disabled={disabled || (!options && !configureDefaults)}
					onChange={(event) => {
						const model = event.target.value || undefined;
						const updated = { ...settings, model };
						change({
							...updated,
							reasoningEffort:
								options && resolveAgentSettings(options, updated).supported
									? settings.reasoningEffort
									: undefined,
						});
					}}
				>
					<option value=''>
						{configureDefaults ? "Codex default" : "Default model"}
						{defaults?.model ? ` (${defaults.model.name})` : ""}
					</option>
					{settings.model && !options?.models.some((value) => value.id === settings.model) && (
						<option value={settings.model}>{settings.model}</option>
					)}
					{options?.models.map((value) => (
						<option key={value.id} value={value.id}>
							{value.name}
						</option>
					))}
				</select>
			</Field>
			<Field>
				{configureDefaults && "Default thinking"}
				<select
					aria-label={configureDefaults ? "Default thinking" : "Thinking level"}
					value={settings.reasoningEffort ?? ""}
					disabled={disabled || (!options && !configureDefaults)}
					onChange={(event) => change({ ...settings, reasoningEffort: event.target.value || undefined })}
				>
					<option value=''>
						{configureDefaults ? "Codex default" : "Default thinking"}
						{thinking ? ` (${thinking})` : ""}
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
			</Field>
			{!configureDefaults && (
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
			)}
		</div>
	);
};
