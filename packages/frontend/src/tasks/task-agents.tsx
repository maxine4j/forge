import { agentOptionsSchema, type AgentOptions } from "@forge/contracts/agents";
import { modelProvidersSchema, type ModelProvider } from "@forge/contracts/model-providers";
import { taskAgentSchema, taskAgentsSchema, type TaskAgent, type TaskAgentModel } from "@forge/contracts/task-agents";
import { useEffect, useRef, useState } from "react";

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
				if (active) setCatalog({ agents: agents.filter((agent) => !agent.retired), providers });
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
			setCatalog(
				(current) => current && { ...current, agents: current.agents.filter(({ id }) => id !== agent.id) },
			);
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
			{catalog.agents.map((agent) => (
				<article className='account-card model-provider-card' key={agent.id}>
					<h3>{agent.name}</h3>
					<ol>
						{agent.models.map((model, index) => (
							<li key={index}>
								{catalog.providers.find(({ id }) => id === model.providerId)?.name
									?? "Unavailable provider"}
								{" · "}
								{model.model ?? "Codex default"}
								{model.reasoningEffort && ` · ${model.reasoningEffort}`}
							</li>
						))}
					</ol>
					{retiring?.id !== agent.id && (
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
			))}
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
	const [rows, setRows] = useState(() =>
		(agent?.models ?? [{ providerId: "" }]).map((value, key) => ({ key, value })),
	);
	const nextKey = useRef(rows.length);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const move = (index: number, direction: number) => {
		const target = index + direction;
		setRows((current) =>
			current.map((row, i) => (i === index ? current.at(target)! : i === target ? current.at(index)! : row)),
		);
	};
	const save = async () => {
		setBusy(true);
		setError("");
		try {
			saved(
				await api.read(
					agent ? `task-agents/${agent.id}` : "task-agents",
					taskAgentSchema,
					agent ? "PATCH" : "POST",
					{ name, models: rows.map(({ value }) => value) },
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
				{rows.map(({ key, value }, index) => (
					<fieldset key={key}>
						<legend>Model {index + 1}</legend>
						<label>
							Model provider
							<select
								required
								value={value.providerId}
								onChange={(event) => {
									const providerId = event.target.value;
									setRows((current) =>
										current.map((row) => (row.key === key ? { key, value: { providerId } } : row)),
									);
								}}
							>
								<option value=''>Select a provider</option>
								{value.providerId && !providers.some(({ id }) => id === value.providerId) && (
									<option value={value.providerId}>Unavailable provider</option>
								)}
								{providers.map((entry) => (
									<option key={entry.id} value={entry.id}>
										{entry.name}
									</option>
								))}
							</select>
						</label>
						<ModelSelection
							key={value.providerId}
							api={api}
							provider={providers.find(({ id }) => id === value.providerId)}
							value={value}
							allowDefault={
								!!agent?.models.some((model) => model.providerId === value.providerId && !model.model)
							}
							change={(value) =>
								setRows((current) => current.map((row) => (row.key === key ? { key, value } : row)))
							}
						/>
						<button
							type='button'
							aria-label={`Move model ${index + 1} up`}
							disabled={index === 0}
							onClick={() => move(index, -1)}
						>
							Move up
						</button>
						<button
							type='button'
							aria-label={`Move model ${index + 1} down`}
							disabled={index === rows.length - 1}
							onClick={() => move(index, 1)}
						>
							Move down
						</button>
						<button
							type='button'
							aria-label={`Remove model ${index + 1}`}
							disabled={rows.length === 1}
							onClick={() => setRows((current) => current.filter((row) => row.key !== key))}
						>
							Remove
						</button>
					</fieldset>
				))}
				<button
					type='button'
					onClick={() => {
						const key = nextKey.current++;
						setRows((current) => [...current, { key, value: { providerId: "" } }]);
					}}
				>
					Add model
				</button>
				{error && <p role='alert'>{error}</p>}
				<button
					className='primary'
					disabled={rows.some(
						({ value }) =>
							!value.model?.trim()
							&& !agent?.models.some((saved) => saved.providerId === value.providerId && !saved.model),
					)}
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

function ModelSelection({
	api,
	provider,
	value,
	allowDefault,
	change,
}: {
	api: IWorkspaceApi;
	provider?: ModelProvider;
	value: TaskAgentModel;
	allowDefault: boolean;
	change: (value: TaskAgentModel) => void;
}) {
	const { model, reasoningEffort: effort } = value;
	const [options, setOptions] = useState<AgentOptions>();
	const [optionsError, setOptionsError] = useState(false);
	const [attempt, retry] = useState(0);
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
	return (
		<>
			{!provider && value.providerId && <p>{model ?? "Codex default"}</p>}
			{provider?.kind === "ollama" && (
				<label>
					Model tag
					<input
						required
						maxLength={256}
						value={model ?? ""}
						onChange={(event) => change({ ...value, model: event.target.value })}
					/>
				</label>
			)}
			{provider?.kind === "openai" && (
				<label>
					Model
					<select
						required={!allowDefault}
						value={model ?? ""}
						disabled={!options}
						onChange={(event) => {
							change({ providerId: value.providerId, model: event.target.value || undefined });
						}}
					>
						<option value=''>
							{optionsError
								? "Models unavailable"
								: !options
									? "Loading models…"
									: allowDefault
										? "Codex default"
										: "Select a model"}
						</option>
						{model && !selected && <option value={model}>{model}</option>}
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
					<select
						value={effort ?? ""}
						onChange={(event) => change({ ...value, reasoningEffort: event.target.value || undefined })}
					>
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
		</>
	);
}
