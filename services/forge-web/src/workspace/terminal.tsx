import { terminalSessionSchema, terminalStatusSchema, terminalServerMessageSchema } from "@forge/contracts/terminal";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { useErrorState } from "../toasts/toasts.tsx";
import { TerminalKeyboardToolbar } from "./terminal-keyboard-toolbar.tsx";
import { controlInput } from "./terminal-keyboard.ts";
import { TerminalStream } from "./terminal-stream.ts";
import { useTerminalKeyboard } from "./use-terminal-keyboard.ts";

import "@xterm/xterm/css/xterm.css";

export const WorkspaceTerminal = ({ id, api }: { id: string; api: IWorkspaceApi }) => {
	const [connection, setConnection] = useState("Connecting…");
	const [, setError] = useErrorState();
	const [gap, setGap] = useState<number>();
	const element = useRef<HTMLDivElement>(null);
	const root = useRef<HTMLElement>(null);
	const terminal = useRef<Terminal | undefined>(undefined);
	const control = useRef(false);
	const [controlPressed, setControlPressed] = useState(false);
	const location = useLocation();
	const keyboard = useTerminalKeyboard(root, location.pathname.endsWith("/terminals"));
	const clearControl = () => {
		control.current = false;
		setControlPressed(false);
	};
	useEffect(() => {
		if (!keyboard || connection !== "Connected") {
			control.current = false;
			// Synchronize the button with the imperative xterm input modifier.
			// oxlint-disable-next-line react/set-state-in-effect
			setControlPressed(false);
		}
	}, [keyboard, connection]);
	useEffect(() => {
		const target = element.current;
		if (!target || !keyboard) return;
		const top = target.getBoundingClientRect().top;
		target.style.height = `${Math.max(44, keyboard.top + keyboard.height - 52 - top)}px`;
		return () => {
			target.style.height = "";
		};
	}, [keyboard]);
	useEffect(() => {
		if (!element.current) return;
		const view = new Terminal({ cursorBlink: true, cols: 80, rows: 24, scrollback: 1000 });
		terminal.current = view;
		const addon = new FitAddon();
		view.loadAddon(addon);
		view.open(element.current);
		const transcript = new TerminalStream(view);
		let socket: WebSocket | undefined;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let disposed = false;
		let delay = 500;
		let retainedSession: string | undefined;
		const dimensions = () => ({
			cols: Math.max(2, Math.min(500, view.cols)),
			rows: Math.max(1, Math.min(200, view.rows)),
		});
		const send = (value: object) => {
			if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
		};
		const schedule = () => {
			if (disposed || retry !== undefined) return;
			setConnection("Reconnecting…");
			retry = setTimeout(() => {
				retry = undefined;
				void connect();
			}, delay);
			delay = Math.min(delay * 2, 8000);
		};
		const connect = async () => {
			try {
				// Inspect before every create, including retries after an ambiguous POST failure.
				const status = await api.read(`workspaces/${id}/terminal`, terminalStatusSchema);
				if (disposed) return;
				let session = status.session;
				if (!session || (session.status !== "running" && session.status !== "starting")) {
					session = await api.read(`workspaces/${id}/terminal`, terminalSessionSchema, "POST", dimensions());
					if (disposed) return;
				}
				const value = session;
				const after = await transcript.prepare(value.id);
				if (disposed) return;
				if (retainedSession !== value.id) setGap(undefined);
				retainedSession = value.id;
				const url = new URL(`/api/terminals/${value.id}/socket`, window.location.href);
				url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
				url.searchParams.set("after", String(after));
				const current = new WebSocket(url);
				socket = current;
				current.onopen = () => {
					if (disposed || socket !== current) return;
					setConnection("Connected");
					setError("");
					addon.fit();
					send({ type: "resize", ...dimensions() });
				};
				current.onclose = () => {
					if (socket !== current) return;
					socket = undefined;
					schedule();
				};
				current.onerror = () => current.close();
				current.onmessage = (event) => {
					if (disposed || socket !== current) return;
					try {
						const frame = terminalServerMessageSchema.parse(JSON.parse(String(event.data)));
						if (frame.type === "output") transcript.output(frame.sequence, frame.data);
						else if (frame.type === "gap") {
							transcript.gap(frame.through);
							setGap(frame.through);
						} else if (frame.session.id === value.id && frame.session.workspaceId === id) {
							if (frame.session.status === "running" || frame.session.status === "starting") delay = 500;
							else {
								setError("Shell ended. Starting a new shell…");
								current.close();
							}
						}
					} catch {
						setError("Invalid terminal response");
						current.close();
					}
				};
			} catch (failure) {
				if (disposed) return;
				setError(failure instanceof Error ? failure.message : "Terminal unavailable");
				schedule();
			}
		};
		view.onData((data) => {
			if (control.current) {
				data = controlInput(data);
				control.current = false;
				setControlPressed(false);
			}
			for (const frame of transcript.input(data)) if (socket?.readyState === WebSocket.OPEN) socket.send(frame);
		});
		view.onResize(() => send({ type: "resize", ...dimensions() }));
		const observer = new ResizeObserver(() => addon.fit());
		observer.observe(element.current);
		setConnection("Connecting…");
		setError("");
		setGap(undefined);
		void connect();
		return () => {
			disposed = true;
			clearTimeout(retry);
			observer.disconnect();
			socket?.close();
			view.dispose();
			terminal.current = undefined;
		};
	}, [id, api, setError]);
	return (
		<section aria-label='Terminal' ref={root}>
			<p role='status'>{connection}</p>

			{gap !== undefined && (
				<p className='notice'>Output gap through {gap}. Some terminal output is unavailable.</p>
			)}
			<div className='terminal-view' ref={element} />
			{keyboard && (
				<div
					className='terminal-keyboard-position'
					style={{ top: keyboard.top + keyboard.height - 52, left: keyboard.left, width: keyboard.width }}
				>
					<TerminalKeyboardToolbar
						connected={connection === "Connected"}
						control={controlPressed}
						toggleControl={() => {
							control.current = !control.current;
							setControlPressed(control.current);
							terminal.current?.focus();
						}}
						input={(value) => {
							clearControl();
							if (connection !== "Connected") return;
							const view = terminal.current;
							view?.input(
								typeof value === "string" ? value : value(view.modes.applicationCursorKeysMode),
								true,
							);
							view?.focus();
						}}
					/>
				</div>
			)}
		</section>
	);
};
