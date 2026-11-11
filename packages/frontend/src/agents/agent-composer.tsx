import {
	agentFilesSchema,
	agentOptionsSchema,
	type AgentContextWindow,
	type AgentOptions,
	type AgentSettings,
} from "@forge/contracts/agents";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";

const number = new Intl.NumberFormat("en-AU");

const ContextWindow = ({ used, max }: AgentContextWindow) => {
	const tooltipId = useId();
	const percent = 100 * (used / max);
	return (
		<div className='agent-context'>
			<button
				type='button'
				aria-label='Context window'
				aria-describedby={tooltipId}
				onClick={(event) => event.currentTarget.focus()}
			>
				<svg width='20' height='20' viewBox='0 0 20 20' aria-hidden='true' fill='none' strokeWidth='2'>
					<circle cx='10' cy='10' r='7' className='agent-context-track' />
					<circle
						cx='10'
						cy='10'
						r='7'
						pathLength='100'
						stroke='currentColor'
						strokeDasharray={`${Math.min(percent, 100)} 100`}
						transform='rotate(-90 10 10)'
					/>
				</svg>
			</button>
			<div id={tooltipId} role='tooltip' className='agent-context-tooltip'>
				<strong>{number.format(Math.round(percent))}% used</strong>
				<div>
					{number.format(used)} of {number.format(max)} tokens
				</div>
			</div>
		</div>
	);
};

export const AgentComposer = ({
	id,
	api,
	draft,
	change,
	send,
	disabled,
	sendable,
	settings,
	contextWindow,
	configurable = true,
}: {
	id: string;
	api: IWorkspaceApi;
	draft: string;
	change: (value: string) => void;
	send: (settings: AgentSettings) => void;
	disabled: boolean;
	sendable: boolean;
	settings: AgentSettings;
	contextWindow?: AgentContextWindow;
	configurable?: boolean;
}) => {
	const inputId = useId();
	const listId = useId();
	const textarea = useRef<HTMLTextAreaElement>(null);
	const pendingCaret = useRef<number | undefined>(undefined);
	useLayoutEffect(() => {
		if (pendingCaret.current === undefined) return;
		textarea.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
		pendingCaret.current = undefined;
	}, [draft]);
	const [options, setOptions] = useState<AgentOptions>();
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);
	const [model, setModel] = useState(settings.model ?? "");
	const [permissions, setPermissions] = useState<NonNullable<AgentSettings["permissions"]>>(
		settings.permissions ?? "ask",
	);
	const [cursor, setCursor] = useState(0);
	const [dismissed, setDismissed] = useState(false);
	const [selected, setSelected] = useState(0);
	const [fileResult, setFileResult] = useState<{ query: string; files: string[]; error: string }>();
	useEffect(() => {
		if (!configurable) return;
		let current = true;
		void api
			.read(`agents/${id}/options`, agentOptionsSchema)
			.then((value) => {
				if (current) {
					setOptions(value);
					setError("");
				}
			})
			.catch(() => {
				if (current) setError("Models and skills unavailable.");
			});
		return () => {
			current = false;
		};
	}, [api, id, attempt, configurable]);
	const match = /(?:^|\s)([$@])([^\s$@]*)$/.exec(draft.slice(0, cursor));
	const trigger = !dismissed && configurable ? match?.[1] : undefined;
	const query = match?.[2] ?? "";
	useEffect(() => {
		if (trigger !== "@") return;
		let current = true;
		const timeout = setTimeout(() => {
			void api
				.read(`agents/${id}/files?query=${encodeURIComponent(query)}`, agentFilesSchema)
				.then((value) => {
					if (current) {
						setFileResult({ query, files: value, error: "" });
					}
				})
				.catch(() => {
					if (current) {
						setFileResult({ query, files: [], error: "Could not search files. Type again to retry." });
					}
				});
		}, 120);
		return () => {
			current = false;
			clearTimeout(timeout);
		};
	}, [api, id, trigger, query]);
	const files = fileResult?.query === query ? fileResult.files : [];
	const fileError = fileResult?.query === query ? fileResult.error : "";
	const searching = trigger === "@" && fileResult?.query !== query;
	const choices =
		trigger === "$"
			? (options?.skills ?? []).filter((skill) =>
					`${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()),
				)
			: files.map((name) => ({ name, description: "" }));
	const visible = Boolean(trigger);
	const update = (value: string, position: number) => {
		change(value);
		setCursor(position);
		setSelected(0);
		setDismissed(false);
	};
	const complete = (index: number) => {
		const choice = choices.at(index);
		if (!choice || !match) return;
		const start = cursor - query.length - 1;
		const insertion = `${trigger}${choice.name} `;
		const value = draft.slice(0, start) + insertion + draft.slice(cursor);
		if (value.length > 8000) return;
		pendingCaret.current = start + insertion.length;
		textarea.current?.focus();
		update(value, start + insertion.length);
		setDismissed(true);
	};
	const selectedModel = model || options?.models.find((model) => model.isDefault)?.id || "";
	const submit = () => {
		if (sendable && !disabled && draft.trim())
			send({ ...(selectedModel ? { model: selectedModel } : {}), permissions });
	};
	return (
		<form
			className='agent-composer'
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<label className='visually-hidden' htmlFor={inputId}>
				Message
			</label>
			{visible && (
				<div className='agent-completions'>
					<div className='agent-completions-heading'>
						{trigger === "$" ? "Skills" : "Files"}
						<small>↑ ↓ to navigate · Tab to insert</small>
					</div>
					<div id={listId} role='listbox' aria-label={trigger === "$" ? "Skills" : "Files"}>
						{choices.slice(0, 100).map((choice, index) => (
							<div
								key={choice.name}
								id={`${listId}-${index}`}
								role='option'
								aria-selected={index === selected}
								onMouseDown={(event) => event.preventDefault()}
								onClick={() => complete(index)}
							>
								<span>
									{trigger === "$" ? "$" : ""}
									{choice.name}
								</span>
								{choice.description && <small>{choice.description}</small>}
							</div>
						))}
					</div>
					{!choices.length && (
						<p role='status'>
							{fileError
								|| (searching
									? "Searching files…"
									: trigger === "$" && !options
										? error || "Loading skills…"
										: "No matches")}
						</p>
					)}
				</div>
			)}
			<textarea
				ref={textarea}
				id={inputId}
				rows={3}
				maxLength={8000}
				placeholder='Ask anything, @ for files, $ for skills'
				value={draft}
				disabled={disabled}
				aria-controls={visible ? listId : undefined}
				aria-autocomplete='list'
				aria-activedescendant={visible && choices.length ? `${listId}-${selected}` : undefined}
				onChange={(event) => update(event.target.value, event.target.selectionStart)}
				onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing || event.keyCode === 229) return;
					if (event.key === "Escape") {
						setDismissed(true);
						return;
					}
					if (visible && choices.length && ["ArrowDown", "ArrowUp", "Tab"].includes(event.key)) {
						event.preventDefault();
						if (event.key === "Tab") complete(selected);
						else
							setSelected(
								(value) =>
									(value + (event.key === "ArrowDown" ? 1 : -1) + Math.min(choices.length, 100))
									% Math.min(choices.length, 100),
							);
						return;
					}
					if (event.key !== "Enter") return;
					if (event.metaKey || event.ctrlKey) {
						event.preventDefault();
						const input = event.currentTarget;
						const position = input.selectionStart;
						const value = draft.slice(0, position) + "\n" + draft.slice(input.selectionEnd);
						if (value.length > 8000) return;
						pendingCaret.current = position + 1;
						update(value, position + 1);
						return;
					}
					if (!event.shiftKey) {
						event.preventDefault();
						submit();
					}
				}}
			/>
			<div className='agent-composer-footer'>
				<div className='agent-composer-settings'>
					{configurable && (
						<>
							<select
								aria-label='Model'
								value={selectedModel}
								disabled={disabled || !sendable || !options}
								onChange={(event) => setModel(event.target.value)}
							>
								{!selectedModel && <option value=''>Default model</option>}
								{settings.model && !options?.models.some((value) => value.id === settings.model) && (
									<option value={settings.model}>{settings.model}</option>
								)}
								{options?.models.map((model) => (
									<option key={model.id} value={model.id}>
										{model.name}
									</option>
								))}
							</select>
							<select
								aria-label='Permissions'
								value={permissions}
								disabled={disabled || !sendable}
								onChange={(event) => {
									const value = event.target.value;
									if (value === "ask" || value === "approve-for-me" || value === "full-access")
										setPermissions(value);
								}}
							>
								<option value='approve-for-me'>Approve for me</option>
								<option value='ask'>Ask</option>
								<option value='full-access'>Full access</option>
							</select>
						</>
					)}
				</div>
				<div className='agent-composer-actions'>
					{contextWindow && <ContextWindow {...contextWindow} />}
					<button
						className='agent-send'
						aria-label='Send message'
						title='Send message'
						disabled={disabled || !sendable || !draft.trim()}
					>
						<svg
							viewBox='0 0 24 24'
							width='18'
							height='18'
							fill='none'
							stroke='currentColor'
							strokeWidth='2'
							aria-hidden='true'
						>
							<path d='M12 19V5m-6 6 6-6 6 6' />
						</svg>
					</button>
				</div>
			</div>
			{error && (
				<div className='agent-composer-error' role='status'>
					{error}{" "}
					<button type='button' onClick={() => setAttempt((value) => value + 1)}>
						Retry
					</button>
				</div>
			)}
		</form>
	);
};
