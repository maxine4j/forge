import {
	boardSettingsSchema,
	boardStopSchema,
	maxConcurrentAgents,
	minConcurrentAgents,
	type BoardSettings,
	type BoardSettingsUpdate,
} from "@forge/contracts/tickets";
import { useEffect, useId, useRef, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { DockerSettings } from "./docker-settings.tsx";

export const BoardSettingsDialog = ({ api, close }: { api: IWorkspaceApi; close: () => void }) => {
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const [settings, setSettings] = useState<BoardSettings>();
	const [limit, setLimit] = useState<number>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [loadAttempt, setLoadAttempt] = useState(0);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	useEffect(() => {
		let current = true;
		void api.read("board/settings", boardSettingsSchema).then(
			(value) => {
				if (!current) return;
				setSettings(value);
				setLimit(value.maxAgents);
			},
			(failure: unknown) => {
				if (current) setError(failure instanceof Error ? failure.message : "Cannot load board settings.");
			},
		);
		return () => {
			current = false;
		};
	}, [api, loadAttempt]);
	const act = async (operation: () => Promise<void>) => {
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await operation();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Cannot update board settings.");
		} finally {
			setBusy(false);
		}
	};
	const update = (input: BoardSettingsUpdate, message: string) =>
		act(async () => {
			const value = await api.read("board/settings", boardSettingsSchema, "PATCH", input);
			setSettings(value);
			if (input.maxAgents !== undefined) setLimit(value.maxAgents);
			setNotice(message);
		});
	const stop = () =>
		act(async () => {
			const result = await api.read("board/settings/stop", boardStopSchema, "POST");
			setSettings(result.settings);
			const message = `Interruption requested for ${result.requested} ${result.requested === 1 ? "agent" : "agents"}. Slots recovered: ${result.recovered}.`;
			if (result.failed)
				setError(
					`${message} ${result.failed} ${result.failed === 1 ? "execution remains" : "executions remain"} unresolved. Retry Stop all agents to reconcile again.`,
				);
			else setNotice(message);
		});
	return (
		<dialog
			ref={dialog}
			className='ticket-dialog board-settings'
			aria-labelledby={titleId}
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) dialog.current?.close();
			}}
			onClose={close}
		>
			<div className='ticket-dialog-heading'>
				<h2 id={titleId}>Board settings</h2>
				<button
					type='button'
					aria-label='Close board settings'
					disabled={busy}
					onClick={() => dialog.current?.close()}
				>
					✕
				</button>
			</div>
			{settings && limit !== undefined ? (
				<>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void update({ maxAgents: limit }, "Agent limit saved.");
						}}
					>
						<label>
							<span>Max concurrent agents</span>
							<input
								type='range'
								min={minConcurrentAgents}
								max={maxConcurrentAgents}
								value={limit}
								disabled={busy}
								onChange={(event) => setLimit(event.currentTarget.valueAsNumber)}
							/>
						</label>
						<span aria-hidden='true'>{limit}</span>
						<button type='submit' disabled={busy || limit === settings.maxAgents}>
							Save limit
						</button>
					</form>
					<p>
						{settings.dispatch === "stopped"
							? "Ticket dispatch is stopped."
							: settings.dispatch === "paused"
								? "Ready tickets are paused. In-progress tickets can continue."
								: "Ready tickets start when agent slots open."}
					</p>
					<div className='board-settings-actions'>
						{settings.dispatch === "running" ? (
							<button
								type='button'
								disabled={busy}
								onClick={() => void update({ dispatch: "paused" }, "New tickets are paused.")}
							>
								Pause new tickets
							</button>
						) : (
							<button
								type='button'
								disabled={busy}
								onClick={() => void update({ dispatch: "running" }, "Ticket dispatch resumed.")}
							>
								Resume ticket dispatch
							</button>
						)}
						<button type='button' className='board-stop' disabled={busy} onClick={() => void stop()}>
							Stop all agents
						</button>
					</div>
					<p className='board-settings-help'>
						Stop interrupts ticket agents and standalone chats across projects.
					</p>
				</>
			) : error ? (
				<button
					type='button'
					onClick={() => {
						setError("");
						setLoadAttempt((attempt) => attempt + 1);
					}}
				>
					Retry
				</button>
			) : (
				<p role='status'>Loading board settings…</p>
			)}
			<DockerSettings api={api} />
			{notice && <p role='status'>{notice}</p>}
			{error && (
				<p role='alert' className='error'>
					{error}
				</p>
			)}
		</dialog>
	);
};
