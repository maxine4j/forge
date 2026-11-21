import { agentOptionsSchema, type AgentOptions } from "@forge/contracts/agents";
import { modelProvidersSchema, type ModelProvider } from "@forge/contracts/model-providers";
import { taskAgentSchema, taskAgentsSchema, type TaskAgent } from "@forge/contracts/task-agents";
import { useEffect, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";

export function TaskAgents({ api }: { api: IWorkspaceApi }) {
	const [catalog, setCatalog] = useState<{ agents: TaskAgent[]; providers: ModelProvider[] }>();
	const [editing, setEditing] = useState<TaskAgent | "new">();
	const [retiring, setRetiring] = useState<TaskAgent>();
	const [attempt, retry] = useState(0);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		let active = true;
		void Promise.all([
			api.read("task-agents", taskAgentsSchema),
			api.read("model-providers", modelProvidersSchema),
		]).then(
			([agents, providers]) => {
				if (active) setCatalog({ agents, providers });
			},
			() => {
				if (active) setError("Could not load agents and model providers.");
			},
		);
		return () => {
			active = false;
		};
	}, [api, attempt]);
	const saved = (agent: TaskAgent) => {
		setCatalog(
			(current) =>
				current && {
					...current,
					agents: current.agents.some((entry) => entry.id === agent.id)
						? current.agents.map((entry) => (entry.id === agent.id ? agent : entry))
						: [...current.agents, agent],
				},
		);
	};
	const retire = async (agent: TaskAgent) => {
		setBusy(true);
		setError("");
		try {
			await api.read(`task-agents/${agent.id}`, { parse: () => undefined }, "DELETE");
			saved({ ...agent, retired: true });
			setRetiring(undefined);
		} catch (error) {
			setError(error instanceof Error ? error.message : "Could not retire agent.");
		} finally {
			setBusy(false);
		}
	};
	if (!catalog)
		return error ? (
			<div>
				<p role='alert'>{error}</p>
				<button
					onClick={() => {
						setError("");
						retry(attempt + 1);
					}}
				>
					Retry
				</button>
			</div>
		) : (
			<p role='status'>Loading agents…</p>
		);
	return (
		<section className='forge-settings task-agent-catalog' aria-label='Agents'>
			<button
				className='primary'
				disabled={!!editing || !!retiring || !catalog.providers.length}
				onClick={() => setEditing("new")}
			>
				Add agent
			</button>
			{!catalog.providers.length && <p>Add a model provider in Config to configure agents.</p>}
			{!catalog.agents.length && <p>No agents configured.</p>}
			{editing && (
				<AgentEditor
					api={api}
					providers={catalog.providers}
					agent={editing === "new" ? undefined : editing}
					cancel={() => setEditing(undefined)}
					saved={(agent) => {
						saved(agent);
						setEditing(undefined);
					}}
				/>
			)}
			{catalog.agents.map((agent) => {
				const provider = catalog.providers.find((entry) => entry.id === agent.providerId);
				return (
					<article className='account-card model-provider-card' key={agent.id}>
						<h3>
							{agent.name}
							{agent.retired ? " (retired)" : ""}
						</h3>
						<p>
							{provider?.name ?? "Unavailable provider"} · {agent.model ?? "Codex default"}
							{agent.reasoningEffort && ` · ${agent.reasoningEffort}`}
						</p>
						{!agent.retired && retiring?.id !== agent.id && (
							<>
								<button
									disabled={!!editing || !!retiring}
									aria-label={`Edit ${agent.name}`}
									onClick={() => setEditing(agent)}
								>
									Edit
								</button>
								<button
									disabled={!!editing || !!retiring}
									aria-label={`Retire ${agent.name}`}
									onClick={() => setRetiring(agent)}
								>
									Retire
								</button>
							</>
						)}
						{retiring?.id === agent.id && (
							<>
								<p>Retire {agent.name}?</p>
								{error && <p role='alert'>{error}</p>}
								<button disabled={busy} onClick={() => void retire(agent)}>
									Retire agent
								</button>
								<button
									disabled={busy}
									onClick={() => {
										setRetiring(undefined);
										setError("");
									}}
								>
									Cancel
								</button>
							</>
						)}
					</article>
				);
			})}
		</section>
	);
}

function AgentEditor({
	api,
	providers,
	agent,
	saved,
	cancel,
}: {
	api: IWorkspaceApi;
	providers: ModelProvider[];
	agent?: TaskAgent;
	saved: (agent: TaskAgent) => void;
	cancel: () => void;
}) {
	const [name, setName] = useState(agent?.name ?? "");
	const [providerId, setProviderId] = useState(agent?.providerId ?? "");
	const [model, setModel] = useState(agent?.model ?? "");
	const [effort, setEffort] = useState(agent?.reasoningEffort ?? "");
	const [options, setOptions] = useState<AgentOptions>();
	const [optionsError, setOptionsError] = useState(false);
	const [attempt, retry] = useState(0);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const provider = providers.find((entry) => entry.id === providerId);
	useEffect(() => {
		if (provider?.kind !== "openai") return;
		let active = true;
		void api.read(`model-providers/${provider.id}/model-options`, agentOptionsSchema).then(
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
	}, [api, provider, attempt]);
	const selected = options?.models.find((entry) => entry.id === model);
	const efforts = selected?.supportedReasoningEfforts ?? [];
	const save = async () => {
		setBusy(true);
		setError("");
		try {
			saved(
				await api.read(
					agent ? `task-agents/${agent.id}` : "task-agents",
					taskAgentSchema,
					agent ? "PATCH" : "POST",
					{
						name,
						providerId,
						model,
						reasoningEffort: efforts.length ? effort || undefined : undefined,
					},
				),
			);
		} catch (error) {
			setError(error instanceof Error ? error.message : "Could not save agent.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			className='account-card task-agent-editor'
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<h3>{agent ? `Edit ${agent.name}` : "Add agent"}</h3>
			<fieldset disabled={busy}>
				<label>
					Name
					<input
						autoFocus
						required
						maxLength={120}
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<label>
					Model provider
					<select
						required
						value={providerId}
						onChange={(event) => {
							setProviderId(event.target.value);
							setModel("");
							setEffort("");
							setOptions(undefined);
							setOptionsError(false);
						}}
					>
						<option value=''>Select a provider</option>
						{providerId && !provider && (
							<option value={providerId} disabled>
								Unavailable provider
							</option>
						)}
						{providers.map((entry) => (
							<option key={entry.id} value={entry.id}>
								{entry.name}
							</option>
						))}
					</select>
				</label>
				{provider?.kind === "ollama" && (
					<label>
						Model tag
						<input
							required
							maxLength={256}
							value={model}
							onChange={(event) => setModel(event.target.value)}
						/>
					</label>
				)}
				{provider?.kind === "openai" && (
					<label>
						Model
						<select
							required
							value={model}
							disabled={!options}
							onChange={(event) => {
								setModel(event.target.value);
								setEffort("");
							}}
						>
							<option value=''>
								{options ? "Select a model" : optionsError ? "Models unavailable" : "Loading models…"}
							</option>
							{model && !selected && (
								<option value={model} disabled>
									{model}
								</option>
							)}
							{options?.models.map((entry) => (
								<option key={entry.id} value={entry.id}>
									{entry.name}
								</option>
							))}
						</select>
					</label>
				)}
				{optionsError && (
					<button
						type='button'
						onClick={() => {
							setOptionsError(false);
							retry(attempt + 1);
						}}
					>
						Retry loading models
					</button>
				)}
				{efforts.length > 0 && (
					<label>
						Thinking level
						<select value={effort} onChange={(event) => setEffort(event.target.value)}>
							<option value=''>
								Model default
								{selected?.defaultReasoningEffort && ` (${selected.defaultReasoningEffort})`}
							</option>
							{effort && !efforts.some((entry) => entry.reasoningEffort === effort) && (
								<option value={effort} disabled>
									{effort}
								</option>
							)}
							{efforts.map((entry) => (
								<option key={entry.reasoningEffort} value={entry.reasoningEffort}>
									{entry.reasoningEffort}
								</option>
							))}
						</select>
					</label>
				)}
				{error && <p role='alert'>{error}</p>}
				<button
					className='primary'
					disabled={!provider || !model.trim() || (provider.kind === "openai" && !selected)}
				>
					Save agent
				</button>
				<button type='button' onClick={cancel}>
					Cancel
				</button>
			</fieldset>
		</form>
	);
}
