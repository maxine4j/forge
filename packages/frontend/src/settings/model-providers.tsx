import { agentOptionsSchema, type AgentOptions } from "@forge/contracts/agents";
import { modelProviderSchema, modelProvidersSchema, type ModelProvider } from "@forge/contracts/model-providers";
import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

import { AgentOptionsRevision, ExecutionSettings } from "../agents/execution-settings.tsx";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { Dropdown, DropdownOption } from "../dropdown.tsx";
import {
	directModalParent,
	nextModal,
	useDialogDismissal,
	useModalDialog,
	useModalDraft,
	useModalNavigation,
} from "../navigation/controller.tsx";
import { useToast } from "../toasts/toasts.tsx";

export function ProviderSelection({
	api,
	value,
	change,
	disabled = false,
	name,
}: {
	api: IWorkspaceApi;
	value?: string;
	change: (id: string) => void;
	disabled?: boolean;
	name?: string;
}) {
	const [providers, setProviders] = useState<ModelProvider[]>([]);
	const revision = useContext(AgentOptionsRevision);
	const { notify } = useToast();
	useEffect(() => {
		let active = true;
		void api.read("model-providers", modelProvidersSchema).then(
			(values) => {
				if (active) setProviders(values);
			},
			() => {
				if (active) notify("Could not load model providers. Reopen to retry.");
			},
		);
		return () => {
			active = false;
		};
	}, [api, notify, revision]);
	return (
		<label>
			Model provider
			<Dropdown aria-label='Model provider' value={value ?? ""} disabled={disabled} onChange={change}>
				<DropdownOption value=''>{disabled && name ? name : "Select a provider"}</DropdownOption>
				{value && !providers.some((p) => p.id === value) && (
					<DropdownOption value={value} disabled>
						{name ?? "Unavailable provider"}
					</DropdownOption>
				)}
				{providers.map((p) => (
					<DropdownOption key={p.id} value={p.id}>
						{disabled && p.id === value && name ? name : p.name}
					</DropdownOption>
				))}
			</Dropdown>
		</label>
	);
}

export function ModelProviders({
	api,
	account,
	changed,
	connectOpenAI,
}: {
	api: IWorkspaceApi;
	account: ReactNode;
	changed: () => void;
	connectOpenAI: () => void;
}) {
	const [providers, setProviders] = useState<ModelProvider[]>([]);
	const [revision, setRevision] = useState(0);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState(false);
	const [query] = useSearchParams();
	const location = useLocation();
	const navigate = useNavigate();
	const initializing = useRef(false);
	const navigation = useModalNavigation();
	const { notify } = useToast();
	useEffect(() => {
		const base = directModalParent(location);
		if (!base || initializing.current) return;
		initializing.current = true;
		void (async () => {
			await navigate(base.pathname + base.search, { replace: true, state: null });
			await navigate(location.pathname + location.search, {
				state: nextModal(base, query.has("remove") ? "remove-provider" : "model-provider"),
			});
			initializing.current = false;
		})();
	}, [location, navigate, query]);
	useEffect(() => {
		let active = true;
		void api.read("model-providers", modelProvidersSchema).then(
			(values) => {
				if (active) { setProviders(values); setLoaded(true); setLoadError(false); }
			},
			() => {
				if (active) { setLoadError(true); notify("Could not load model providers."); }
			},
		);
		return () => {
			active = false;
		};
	}, [api, revision, notify]);
	const selected = query.get("provider");
	const current = providers.find((p) => p.id === selected);
	return (
		<section className='forge-settings' aria-labelledby='model-providers-heading'>
			<h2 id='model-providers-heading'>Model providers</h2>
			{providers.map((p) => (
				<article className='account-card model-provider-card' key={p.id}>
					<h3>{p.name}</h3>
					<p>{p.kind === "openai" ? "OpenAI account" : "Ollama"}</p>
					{p.kind === "openai" ? (
						account
					) : (
						<p>
							{p.endpoint}
							<br />
							{p.model}
						</p>
					)}
					<button
						type='button'
						aria-label={`Edit ${p.name}`}
						onClick={() => navigation.open("model-provider", `/config?provider=${p.id}`)}
					>
						Edit
					</button>
					<button
						type='button'
						aria-label={`Remove ${p.name}`}
						onClick={() => navigation.open("remove-provider", `/config?provider=${p.id}&remove=true`)}
					>
						Remove
					</button>
				</article>
			))}
			{loaded && !providers.length && <p>No model providers. Add one to run tickets or create chats.</p>}
			{!loaded && !loadError && <p role='status'>Loading model providers…</p>}
			{loadError && <button type='button' onClick={() => setRevision((v) => v + 1)}>Retry loading providers</button>}
			<button type='button' disabled={!loaded} onClick={() => navigation.open("model-provider", "/config?provider=new")}>
				Add provider
			</button>
			{selected && (selected === "new" || current) && (
				<ProviderEditor
					key={`${selected}:${query.has("remove")}`}
					api={api}
					provider={current}
					hasOpenAI={providers.some((p) => p.kind === "openai")}
					account={account}
					connectOpenAI={connectOpenAI}
					remove={query.has("remove")}
					saved={(value) => {
						setProviders((current) =>
							value.retired
								? current.filter((p) => p.id !== value.id)
								: current.some((p) => p.id === value.id)
									? current.map((p) => (p.id === value.id ? value : p))
									: [...current, value],
						);
						setRevision((v) => v + 1);
						changed();
					}}
				/>
			)}
		</section>
	);
}

function ProviderEditor({
	api,
	provider,
	hasOpenAI,
	account,
	connectOpenAI,
	remove,
	saved,
}: {
	api: IWorkspaceApi;
	provider?: ModelProvider;
	hasOpenAI: boolean;
	account: ReactNode;
	connectOpenAI: () => void;
	remove: boolean;
	saved: (provider: ModelProvider) => void;
}) {
	const [name, setName] = useState(provider?.name ?? "");
	const [kind, setKind] = useState(provider?.kind ?? (hasOpenAI ? "ollama" : "openai"));
	const [endpoint, setEndpoint] = useState(provider?.endpoint ?? "");
	const [model, setModel] = useState(provider?.model ?? "");
	const [defaults, setDefaults] = useState({
		model: provider?.defaultAgentModel,
		reasoningEffort: provider?.defaultAgentReasoningEffort,
	});
	const [options, setOptions] = useState<AgentOptions>();
	const [optionsError, setOptionsError] = useState(false);
	const [optionsAttempt, setOptionsAttempt] = useState(0);
	const [busy, setBusy] = useState(false);
	const [persisted, setPersisted] = useState(provider);
	const [dirty, setDirty] = useState(false);
	const dialog = useRef<HTMLDialogElement>(null);
	const navigation = useModalNavigation();
	const dismissal = useDialogDismissal(busy);
	const release = useModalDraft(dirty, busy);
	const { notify } = useToast();
	useModalDialog(dialog);
	useEffect(() => {
		if (persisted?.kind !== "openai") return;
		let active = true;
		void api.read(`model-providers/${persisted.id}/model-options`, agentOptionsSchema).then(
			(value) => {
				if (active) setOptions(value);
			},
			() => {
				if (active) {
					setOptionsError(true);
					notify("Could not load model options.");
				}
			},
		);
		return () => {
			active = false;
		};
	}, [api, persisted, optionsAttempt, notify]);
	const save = async () => {
		setBusy(true);
		try {
			if (remove && provider) {
				await api.read(`model-providers/${provider.id}`, { parse: () => undefined }, "DELETE");
				saved({ ...provider, retired: true });
				release();
				await navigation.completeConfirmation();
				return;
			}
			const input =
				kind === "ollama"
					? { name, kind, endpoint, model }
					: {
							name,
							kind,
							defaultAgentModel: defaults.model ?? (persisted ? null : undefined),
							defaultAgentReasoningEffort: defaults.reasoningEffort ?? (persisted ? null : undefined),
						};
			const value = await api.read(
				persisted ? `model-providers/${persisted.id}` : "model-providers",
				modelProviderSchema,
				persisted ? "PATCH" : "POST",
				input,
			);
			setPersisted(value);
			setDirty(false);
			saved(value);
			release();
			if (kind === "ollama" || persisted) navigation.dismiss();
			else {
				navigation.replace("model-provider", `/config?provider=${value.id}`);
				connectOpenAI();
				notify("Provider saved. Connect your OpenAI account below, or reuse the verified account.", "success");
			}
		} catch (error) {
			notify(error instanceof Error ? error.message : "Could not save provider.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<dialog
			ref={dialog}
			className='ticket-dialog'
			aria-label={remove ? "Remove provider" : "Model provider"}
			{...dismissal}
		>
			<h2>{remove ? `Remove ${name}?` : persisted ? "Edit provider" : "Add provider"}</h2>
			{remove ? (
				<p>The provider will be retired. Existing executions and credentials are preserved.</p>
			) : (
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
					onChange={() => setDirty(true)}
				>
					<fieldset disabled={busy}>
						<label>
							Name
							<input
								autoFocus
								required
								maxLength={120}
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</label>
						<label>
							Type
							<Dropdown
								aria-label='Provider type'
								value={kind}
								disabled={!!persisted}
								onChange={(v) => {
									setKind(v as typeof kind);
									setDirty(true);
								}}
							>
								<DropdownOption value='openai' disabled={hasOpenAI && provider?.kind !== "openai"}>
									OpenAI account
								</DropdownOption>
								<DropdownOption value='ollama'>Ollama</DropdownOption>
							</Dropdown>
						</label>
						{kind === "ollama" && (
							<>
								<label>
									Responses API base URL
									<input
										required
										placeholder='http://ollama:11434/v1'
										value={endpoint}
										onChange={(e) => setEndpoint(e.target.value)}
									/>
								</label>
								<label>
									Model tag
									<input required value={model} onChange={(e) => setModel(e.target.value)} />
								</label>
							</>
						)}
						{kind === "openai" && persisted && (
							<>
								{account}
								{optionsError && (
									<button
										type='button'
										onClick={() => {
											setOptionsError(false);
											setOptionsAttempt((v) => v + 1);
										}}
									>
										Retry loading models
									</button>
								)}
								<ExecutionSettings
									configureDefaults
									options={options}
									settings={defaults}
									change={(value) => {
										setDefaults({ model: value.model, reasoningEffort: value.reasoningEffort });
										setDirty(true);
									}}
								/>
							</>
						)}
						<button className='primary' type='submit'>
							{busy ? "Saving…" : kind === "openai" && !persisted ? "Continue" : "Save provider"}
						</button>
					</fieldset>
				</form>
			)}
			<div className='ticket-dialog-actions'>
				{remove && (
					<button type='button' disabled={busy} onClick={() => void save()}>
						Remove provider
					</button>
				)}
				<button type='button' disabled={busy} onClick={() => navigation.dismiss()}>
					Close
				</button>
			</div>
		</dialog>
	);
}
