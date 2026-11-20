import { agentOptionsSchema, type AgentOptions } from "@forge/contracts/agents";
import {
	ticketPhaseSettings,
	type TicketAgentPhase,
	type TicketExecutionSettings,
	type TicketWorkflow,
} from "@forge/contracts/tickets";
import { useContext, useEffect, useState } from "react";

import { AgentOptionsRevision, ExecutionSettings } from "../agents/execution-settings.tsx";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { ProviderSelection } from "../settings/model-providers.tsx";
import { useErrorState } from "../toasts/toasts.tsx";

export function TicketAgentSettings({
	api,
	ticketId,
	phase,
	settings,
	job,
	change,
	disabled = false,
	permissions = false,
	providerOnly = false,
}: {
	api: IWorkspaceApi;
	ticketId?: string;
	phase: TicketAgentPhase;
	settings: TicketExecutionSettings;
	job?: TicketWorkflow;
	change: (value: TicketExecutionSettings) => void;
	disabled?: boolean;
	permissions?: boolean;
	providerOnly?: boolean;
}) {
	const selection = ticketPhaseSettings(settings, phase);
	const linked = phase === "implementation" && settings.implementation?.mode !== "custom";
	const pinned = phase === "planning" ? job?.planningProvider : job?.implementationProvider;
	const thread = phase === "planning" ? job?.plannerId : job?.implementerId;
	const inheritedPin = linked ? job?.planningProvider : undefined;
	const [loaded, setLoaded] = useState<{ key: string; options: AgentOptions }>();
	const revision = useContext(AgentOptionsRevision);
	const [, setError] = useErrorState();
	const key = JSON.stringify([selection.providerId, pinned, inheritedPin, thread, phase, revision]);
	const options = loaded?.key === key ? loaded.options : undefined;
	useEffect(() => {
		let active = true;
		if (!selection.providerId && !pinned && !thread) return;
		const path =
			ticketId && (pinned || inheritedPin || thread)
				? `tickets/${ticketId}/model-options?phase=${phase}`
				: `model-providers/${selection.providerId}/model-options`;
		void api
			.read(path, agentOptionsSchema)
			.then((options) => {
				if (active) setLoaded({ key, options });
			})
			.catch(() => {
				if (active) setError("Models unavailable.");
			});
		return () => {
			active = false;
		};
	}, [api, ticketId, phase, key, selection.providerId, pinned, inheritedPin, thread, setError]);
	return (
		<div
			className='ticket-agent-selection'
			role='group'
			aria-label={phase === "planning" ? "Planning agent settings" : "Implementing agent settings"}
		>
			<ProviderSelection
				api={api}
				label={phase === "planning" ? "Planning agent" : "Implementing agent"}
				emptyLabel={phase === "planning" ? "Select a provider" : "Same as planner"}
				value={linked ? "" : (pinned?.providerId ?? selection.providerId)}
				name={linked ? "Same as planner" : pinned?.providerName}
				disabled={
					disabled
					|| !!pinned
					|| !!thread
					|| (phase === "planning"
						&& settings.implementation?.mode !== "custom"
						&& !!job?.implementationProvider)
				}
				change={(providerId) =>
					change(
						phase === "planning"
							? {
									...settings,
									providerId: providerId || undefined,
									model: undefined,
									reasoningEffort: undefined,
								}
							: {
									...settings,
									implementation: providerId
										? { mode: "custom", providerId }
										: { mode: "same-as-planner" },
								},
					)
				}
			/>
			{linked && !providerOnly && (
				<>
					<ProviderSelection
						api={api}
						label='Inherited planning agent'
						value={pinned?.providerId ?? inheritedPin?.providerId ?? settings.providerId}
						name={pinned?.providerName ?? inheritedPin?.providerName}
						disabled
						change={() => {}}
					/>
					<p>Inherits planning provider, model and thinking level.</p>
				</>
			)}
			{!providerOnly && (
				<ExecutionSettings
					settings={selection}
					options={options}
					disabled={disabled}
					selectionDisabled={linked}
					hidePermissions={!permissions}
					providerDefault
					change={(value) =>
						change(
							phase === "planning"
								? { ...settings, ...value }
								: {
										...settings,
										permissions: value.permissions,
										implementation: linked
											? settings.implementation
											: {
													mode: "custom",
													providerId: selection.providerId!,
													model: value.model,
													reasoningEffort: value.reasoningEffort,
												},
									},
						)
					}
				/>
			)}
		</div>
	);
}
