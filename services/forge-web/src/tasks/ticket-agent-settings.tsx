import { modelProvidersSchema } from "@forge/contracts/model-providers";
import { taskAgentsSchema, type TaskAgent } from "@forge/contracts/task-agents";
import {
	resolveTicketWorkflowPreset,
	type TicketExecutionSettings,
	type TicketWorkflow,
} from "@forge/contracts/tickets";
import { useEffect, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { useErrorState } from "../toasts/toasts.tsx";

export function TicketAgentSettings({
	api,
	settings,
	job,
	change,
	disabled,
}: {
	api: IWorkspaceApi;
	settings: TicketExecutionSettings;
	job?: TicketWorkflow;
	change: (value: TicketExecutionSettings) => void;
	disabled: boolean;
}) {
	const [catalog, setCatalog] = useState<{ agents: TaskAgent[]; providers: Set<string> }>();
	const [, setError] = useErrorState();
	useEffect(() => {
		let active = true;
		void Promise.all([
			api.read("task-agents", taskAgentsSchema),
			api.read("model-providers", modelProvidersSchema),
		]).then(
			([agents, providers]) => {
				if (active) setCatalog({ agents, providers: new Set(providers.map((provider) => provider.id)) });
			},
			() => {
				if (active) setError("Could not load agents.");
			},
		);
		return () => {
			active = false;
		};
	}, [api, setError]);
	const choices =
		catalog?.agents.filter(
			(agent) => !agent.retired && agent.models.some(({ providerId }) => catalog.providers.has(providerId)),
		) ?? [];
	return (
		<>
			{(
				[
					["Planner", "plannerAgentId", job?.planningProvider, job?.plannerId],
					["Implementer", "implementerAgentId", job?.implementationProvider, job?.implementerId],
				] as const
			)
				.filter(
					([label]) =>
						label !== "Planner" || (resolveTicketWorkflowPreset(settings) !== "one-shot" && !job?.plan),
				)
				.map(([label, key, pin, thread]) => {
					const value = settings[key] ?? "";
					const saved = catalog?.agents.find((agent) => agent.id === value);
					return (
						<label key={key}>
							{label}
							<select
								value={value}
								disabled={disabled || !catalog || !!pin || !!thread}
								onChange={(event) => change({ [key]: event.target.value || undefined })}
							>
								<option value=''>{pin?.providerName ?? "Select an agent"}</option>
								{value && !choices.some((agent) => agent.id === value) && (
									<option value={value} disabled>
										{saved?.name ?? pin?.providerName ?? "Unavailable agent"}
										{saved?.retired ? " (retired)" : ""}
									</option>
								)}
								{choices.map((agent) => (
									<option key={agent.id} value={agent.id}>
										{agent.name}
									</option>
								))}
							</select>
						</label>
					);
				})}
			<label>
				Permissions
				<select
					value={settings.permissions ?? "ask"}
					disabled={disabled}
					onChange={(event) =>
						change({ permissions: event.target.value as TicketExecutionSettings["permissions"] })
					}
				>
					<option value='ask'>Ask</option>
					<option value='approve-for-me'>Approve for me</option>
					<option value='full-access'>Full access</option>
				</select>
			</label>
		</>
	);
}
