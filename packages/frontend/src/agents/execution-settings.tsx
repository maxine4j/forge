import { resolveAgentSettings, type AgentOptions, type AgentSettings } from "@forge/contracts/agents";
import { createContext, Fragment } from "react";

import { Dropdown, DropdownOption } from "../dropdown.tsx";

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
				<Dropdown
					aria-label={configureDefaults ? "Default model" : "Model"}
					value={settings.model ?? ""}
					disabled={disabled || (!options && !configureDefaults)}
					onChange={(value) => {
						const model = value || undefined;
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
					<DropdownOption value=''>
						{configureDefaults ? "Codex default" : "Default model"}
						{defaults?.model ? ` (${defaults.model.name})` : ""}
					</DropdownOption>
					{settings.model && !options?.models.some((value) => value.id === settings.model) && (
						<DropdownOption value={settings.model}>{settings.model}</DropdownOption>
					)}
					{options?.models.map((value) => (
						<DropdownOption key={value.id} value={value.id}>
							{value.name}
						</DropdownOption>
					))}
				</Dropdown>
			</Field>
			<Field>
				{configureDefaults && "Default thinking"}
				<Dropdown
					aria-label={configureDefaults ? "Default thinking" : "Thinking level"}
					value={settings.reasoningEffort ?? ""}
					disabled={disabled || (!options && !configureDefaults)}
					onChange={(value) => change({ ...settings, reasoningEffort: value || undefined })}
				>
					<DropdownOption value=''>
						{configureDefaults ? "Codex default" : "Default thinking"}
						{thinking ? ` (${thinking})` : ""}
					</DropdownOption>
					{settings.reasoningEffort
						&& !model?.supportedReasoningEfforts?.some(
							(value) => value.reasoningEffort === settings.reasoningEffort,
						) && (
							<DropdownOption value={settings.reasoningEffort}>{settings.reasoningEffort}</DropdownOption>
						)}
					{model?.supportedReasoningEfforts?.map((value) => (
						<DropdownOption key={value.reasoningEffort} value={value.reasoningEffort}>
							{value.reasoningEffort}
						</DropdownOption>
					))}
				</Dropdown>
			</Field>
			{!configureDefaults && (
				<Dropdown
					aria-label='Permissions'
					value={settings.permissions ?? "ask"}
					disabled={disabled}
					onChange={(value) => change({ ...settings, permissions: value as AgentSettings["permissions"] })}
				>
					<DropdownOption value='ask'>Ask</DropdownOption>
					{(options?.supportsAutoReview !== false || settings.permissions === "approve-for-me") && (
						<DropdownOption value='approve-for-me' disabled={options?.supportsAutoReview === false}>
							{options?.supportsAutoReview === false
								? "Approve for me (unavailable on Ollama)"
								: "Approve for me"}
						</DropdownOption>
					)}
					<DropdownOption value='full-access'>Full access</DropdownOption>
				</Dropdown>
			)}
		</div>
	);
};
