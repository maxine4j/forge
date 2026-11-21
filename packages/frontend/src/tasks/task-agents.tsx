import { agentOptionsSchema, type AgentOptions } from "@forge/contracts/agents";
import { modelProvidersSchema, type ModelProvider } from "@forge/contracts/model-providers";
import {
	agentAvatarColours,
	taskAgentSchema,
	taskAgentsSchema,
	type TaskAgent,
	type TaskAgentModel,
} from "@forge/contracts/task-agents";
import { useEffect, useRef, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { useDialogDismissal, useModalDialog, useModalDraft, useModalNavigation } from "../navigation/controller.tsx";
import { AgentAvatar } from "./agent-avatar.tsx";

export function TaskAgents({
	api,
	creating,
	closeCreate,
}: {
	api: IWorkspaceApi;
	creating: boolean;
	closeCreate: () => void;
}) {
	const [catalog, setCatalog] = useState<{ agents: TaskAgent[]; providers: ModelProvider[] }>();
	const [retiring, setRetiring] = useState<TaskAgent>();
	const navigation = useModalNavigation();
	const editing = navigation.modal?.owner === "task-agent" ? navigation.modal.selection : undefined;
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
			setError(error instanceof Error ? error.message : "Could not archive agent.");
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
			{!catalog.providers.length && <p>Add a model provider in Config to configure agents.</p>}
			{!catalog.agents.length && <p>No agents configured.</p>}
			{creating && (
				<AgentEditor
					api={api}
					providers={catalog.providers}
					cancel={closeCreate}
					saved={(agent) => {
						saved(agent);
						closeCreate();
					}}
				/>
			)}
			{catalog.agents.map((agent) => (
				<article className='account-card model-provider-card' key={agent.id}>
					<div className='task-agent-summary'>
						<h3>
							<AgentAvatar colour={agent.avatarColour} />
							{agent.name}
						</h3>
						<ol aria-label={`${agent.name} model priority`}>
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
						<button
							type='button'
							className='task-agent-edit'
							aria-label={`Edit ${agent.name}`}
							disabled={!!retiring}
							onClick={() => navigation.open("task-agent", undefined, agent.id)}
						>
							Edit
						</button>
					</div>
					{editing === agent.id && (
						<AgentEditor
							api={api}
							providers={catalog.providers}
							agent={agent}
							saved={saved}
							cancel={navigation.dismiss}
							complete={navigation.dismiss}
						/>
					)}
					{retiring?.id !== agent.id && (
						<>
							<button
								type='button'
								className='ticket-archive-action task-agent-archive'
								disabled={!!retiring || editing === agent.id}
								aria-label={`Archive ${agent.name}`}
								title='Archive agent'
								onClick={() => setRetiring(agent)}
							>
								<svg
									width='16'
									height='16'
									viewBox='0 0 24 24'
									fill='none'
									stroke='currentColor'
									strokeWidth='2'
									strokeLinecap='round'
									strokeLinejoin='round'
									aria-hidden='true'
								>
									<rect x='3' y='3' width='18' height='5' rx='1' />
									<path d='M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8m-9 4h4' />
								</svg>
							</button>
						</>
					)}
					{retiring?.id === agent.id && (
						<>
							<p>Archive {agent.name}?</p>
							{error && <p role='alert'>{error}</p>}
							<button disabled={busy} onClick={() => void retire(agent)}>
								Archive agent
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
	complete,
}: {
	api: IWorkspaceApi;
	providers: ModelProvider[];
	agent?: TaskAgent;
	saved: (agent: TaskAgent) => void;
	cancel: () => void;
	complete?: () => void;
}) {
	const [name, setName] = useState(agent?.name ?? "");
	const [nameDraft, setNameDraft] = useState<string>();
	const [avatarColour, setAvatarColour] = useState(agent?.avatarColour);
	const [maxConcurrentTickets, setMaxConcurrentTickets] = useState(String(agent?.maxConcurrentTickets ?? 1));
	const [rows, setRows] = useState(() =>
		(agent?.models ?? [{ providerId: "" }]).map((value, key) => ({ key, value })),
	);
	const nextKey = useRef(rows.length);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const dragged = useRef<{ key: number; original: typeof rows; dropped: boolean } | undefined>(undefined);
	const [draggedKey, setDraggedKey] = useState<number>();
	const dialog = useRef<HTMLDialogElement>(null);
	const dismissal = useDialogDismissal(busy);
	const dirty =
		!!agent
		&& ((nameDraft !== undefined && nameDraft !== agent.name)
			|| avatarColour !== agent.avatarColour
			|| maxConcurrentTickets !== String(agent.maxConcurrentTickets)
			|| JSON.stringify(rows.map(({ value }) => value)) !== JSON.stringify(agent.models));
	const release = useModalDraft(dirty, busy, undefined, "task-agent");
	useModalDialog(dialog, !!agent);
	const saveName = async () => {
		if (!agent || nameDraft === undefined || !nameDraft.trim()) return;
		setBusy(true);
		setError("");
		try {
			const result = await api.read(`task-agents/${agent.id}`, taskAgentSchema, "PATCH", {
				name: nameDraft,
				models: agent.models,
				maxConcurrentTickets: agent.maxConcurrentTickets,
			});
			setName(result.name);
			setNameDraft(undefined);
			saved(result);
		} catch (error) {
			setError(error instanceof Error ? error.message : "Could not save agent.");
		} finally {
			setBusy(false);
		}
	};
	const move = (index: number, direction: number) => {
		const target = index + direction;
		if (target < 0 || target >= rows.length) return;
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
					{
						name,
						models: rows.map(({ value }) => value),
						maxConcurrentTickets: Number(maxConcurrentTickets),
						avatarColour,
					},
				),
			);
			release();
			complete?.();
		} catch (error) {
			setError(error instanceof Error ? error.message : "Could not save agent.");
		} finally {
			setBusy(false);
		}
	};
	const form = (
		<form
			className={agent ? "task-agent-editor task-agent-inline" : "account-card task-agent-editor"}
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			{agent ? (
				nameDraft === undefined ? (
					<h3 className='ticket-title'>
						<button
							type='button'
							aria-label={`Edit title: ${name}`}
							title='Edit title'
							onClick={() => setNameDraft(name)}
						>
							{name}
						</button>
					</h3>
				) : (
					<div className='ticket-title-editor'>
						<input
							autoFocus
							aria-label='Title'
							maxLength={120}
							value={nameDraft}
							onChange={(event) => setNameDraft(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape") setNameDraft(undefined);
								if (event.key === "Enter") {
									event.preventDefault();
									void saveName();
								}
							}}
						/>
						<button
							type='button'
							aria-label='Save title'
							disabled={busy || !nameDraft.trim()}
							onClick={() => void saveName()}
						>
							✓
						</button>
						<button
							type='button'
							aria-label='Discard title changes'
							disabled={busy}
							onClick={() => setNameDraft(undefined)}
						>
							✕
						</button>
					</div>
				)
			) : (
				<h3>Create agent</h3>
			)}
			<fieldset disabled={busy}>
				{agent && (
					<fieldset className='agent-colour-picker'>
						<legend>Avatar colour</legend>
						{agentAvatarColours.map((colour) => (
							<label key={colour} title={colour}>
								<input
									className='visually-hidden'
									type='radio'
									name='avatar-colour'
									aria-label={colour}
									checked={avatarColour === colour}
									onChange={() => setAvatarColour(colour)}
								/>
								<AgentAvatar colour={colour} />
							</label>
						))}
					</fieldset>
				)}
				{!agent && (
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
				)}
				<label>
					Max concurrent tickets
					<input
						type='number'
						min={1}
						max={Number.MAX_SAFE_INTEGER}
						step={1}
						required
						value={maxConcurrentTickets}
						onChange={(event) => setMaxConcurrentTickets(event.target.value)}
					/>
				</label>
				{rows.map(({ key, value }, index) => (
					<div
						key={key}
						className={`task-agent-model-row${draggedKey === key ? " is-dragging" : ""}`}
						role='group'
						aria-label={`Model ${index + 1}`}
						onDragOver={(event) => {
							if (!dragged.current) return;
							event.preventDefault();
							const draggedRow = dragged.current.key;
							if (draggedRow === key) return;
							setRows((current) => {
								const from = current.findIndex((row) => row.key === draggedRow);
								const target = current.findIndex((row) => row.key === key);
								if (from < 0 || target < 0 || from === target) return current;
								const next = [...current];
								const [row] = next.splice(from, 1);
								if (row) next.splice(target, 0, row);
								return next;
							});
						}}
						onDrop={(event) => {
							event.preventDefault();
							if (dragged.current) dragged.current.dropped = true;
						}}
					>
						<button
							type='button'
							draggable
							aria-label={`Drag model ${index + 1}`}
							title='Drag or use arrow keys to reorder'
							onKeyDown={(event) => {
								if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
								event.preventDefault();
								move(index, event.key === "ArrowUp" ? -1 : 1);
							}}
							onDragStart={(event) => {
								const row = event.currentTarget.parentElement;
								if (row) {
									const bounds = row.getBoundingClientRect();
									event.dataTransfer.setDragImage(
										row,
										event.clientX - bounds.left,
										event.clientY - bounds.top,
									);
								}
								dragged.current = { key, original: rows, dropped: false };
								setDraggedKey(key);
							}}
							onDragEnd={() => {
								if (dragged.current && !dragged.current.dropped) setRows(dragged.current.original);
								dragged.current = undefined;
								setDraggedKey(undefined);
							}}
						>
							⋮⋮
						</button>
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
							aria-label={`Remove model ${index + 1}`}
							disabled={rows.length === 1}
							onClick={() => setRows((current) => current.filter((row) => row.key !== key))}
						>
							Remove
						</button>
					</div>
				))}
				{error && <p role='alert'>{error}</p>}
				<div className='task-agent-actions'>
					<button
						type='button'
						onClick={() => {
							const key = nextKey.current++;
							setRows((current) => [...current, { key, value: { providerId: "" } }]);
						}}
					>
						Add model
					</button>
					<button
						type='button'
						onClick={() => {
							cancel();
						}}
					>
						Cancel
					</button>
					<button
						className='primary'
						disabled={rows.some(
							({ value }) =>
								!value.model?.trim()
								&& !agent?.models.some(
									(saved) => saved.providerId === value.providerId && !saved.model,
								),
						)}
					>
						Save agent
					</button>
				</div>
			</fieldset>
		</form>
	);
	return agent ? (
		<dialog
			ref={dialog}
			className='ticket-dialog task-agent-dialog'
			aria-label={`Edit ${agent.name}`}
			{...dismissal}
		>
			{form}
		</dialog>
	) : (
		form
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
