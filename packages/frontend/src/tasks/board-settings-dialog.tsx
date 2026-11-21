import {
	boardSettingsSchema,
	boardStopSchema,
	type BoardSettings,
	type BoardSettingsUpdate,
} from "@forge/contracts/tickets";
import { useEffect, useId, useRef, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { useDialogDismissal, useModalDialog } from "../navigation/controller.tsx";
import { useErrorState } from "../toasts/toasts.tsx";
import { DockerSettings } from "./docker-settings.tsx";

export const useBoardSettings = (api: IWorkspaceApi, visible: boolean) => {
	const [settings, setSettings] = useState<BoardSettings>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useErrorState();
	const [notice, setNotice] = useState("");
	const [loadAttempt, setLoadAttempt] = useState(0);
	const updating = useRef(false);
	useEffect(() => {
		if (!visible || settings) return;
		let current = true;
		void api.read("board/settings", boardSettingsSchema).then(
			(value) => {
				if (!current) return;
				setSettings(value);
			},
			(failure: unknown) => {
				if (current) setError(failure instanceof Error ? failure.message : "Cannot load board settings.");
			},
		);
		return () => {
			current = false;
		};
	}, [api, loadAttempt, settings, visible, setError]);
	const act = async (operation: () => Promise<void>) => {
		if (updating.current) return;
		updating.current = true;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			await operation();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "Cannot update board settings.");
		} finally {
			updating.current = false;
			setBusy(false);
		}
	};
	const update = (input: BoardSettingsUpdate, message: string) =>
		act(async () => {
			const value = await api.read("board/settings", boardSettingsSchema, "PATCH", input);
			setSettings(value);
			setNotice(message);
		});
	const stop = () =>
		act(async () => {
			const result = await api.read("board/settings/stop", boardStopSchema, "POST");
			setSettings(result.settings);
			const message = `Interruption requested for ${result.requested} ${result.requested === 1 ? "agent" : "agents"}. Executions settled: ${result.recovered}.`;
			if (result.failed)
				setError(
					`${message} ${result.failed} ${result.failed === 1 ? "execution remains" : "executions remain"} unresolved. Retry Stop all agents to reconcile again.`,
				);
			else setNotice(message);
		});
	const dispatchLabel = settings?.dispatch === "running" ? "Pause new tickets" : "Resume ticket dispatch";
	const toggleDispatch = () =>
		settings?.dispatch === "running"
			? update({ dispatch: "paused" }, "New tickets are paused.")
			: update({ dispatch: "running" }, "Ticket dispatch resumed.");
	const retry = () => {
		setError("");
		setLoadAttempt((attempt) => attempt + 1);
	};
	return { settings, busy, error, notice, update, stop, dispatchLabel, toggleDispatch, retry };
};

export const BoardSettingsDialog = ({
	api,
	close,
	board,
}: {
	api: IWorkspaceApi;
	close: () => void;
	board: ReturnType<typeof useBoardSettings>;
}) => {
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();
	const { settings, busy, error, notice, stop, dispatchLabel, toggleDispatch, retry } = board;
	const dismissal = useDialogDismissal(busy);
	useModalDialog(dialog);
	return (
		<dialog ref={dialog} className='ticket-dialog board-settings' aria-labelledby={titleId} {...dismissal}>
			<div className='ticket-dialog-heading'>
				<h2 id={titleId}>Board settings</h2>
				<button type='button' aria-label='Close board settings' disabled={busy} onClick={close}>
					✕
				</button>
			</div>
			{settings ? (
				<>
					<p>
						{settings.dispatch === "stopped"
							? "Ticket dispatch is stopped."
							: settings.dispatch === "paused"
								? "Ready tickets are paused. In-progress tickets can continue."
								: "Ready tickets start when provider capacity opens."}
					</p>
					<div className='board-settings-actions'>
						<button type='button' disabled={busy} onClick={() => void toggleDispatch()}>
							{dispatchLabel}
						</button>
						<button type='button' className='board-stop' disabled={busy} onClick={() => void stop()}>
							Stop all agents
						</button>
					</div>
					<p className='board-settings-help'>Stop interrupts ticket agents throughout Forge.</p>
				</>
			) : error ? (
				<button type='button' onClick={retry}>
					Retry
				</button>
			) : (
				<p role='status'>Loading board settings…</p>
			)}
			<DockerSettings api={api} />
			{notice && <p role='status'>{notice}</p>}
		</dialog>
	);
};
