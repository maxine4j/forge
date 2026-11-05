import { terminalSessionSchema, terminalStatusSchema, terminalServerMessageSchema } from "@forge/contracts/terminal";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { TerminalStream } from "./terminal-stream.ts";

import "@xterm/xterm/css/xterm.css";

export const WorkspaceTerminal = ({ id, api }: { id: string; api: IWorkspaceApi }) => {
	const [connection, setConnection] = useState("Connecting…");
	const [error, setError] = useState("");
	const [gap, setGap] = useState<number>();
	const element = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!element.current) return;
		const view = new Terminal({ cursorBlink: true, cols: 80, rows: 24, scrollback: 1000 });
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
		};
	}, [id, api]);
	return (
		<section aria-label='Terminal'>
			<p role='status'>{connection}</p>
			{error && (
				<p role='alert' className='error'>
					{error}
				</p>
			)}
			{gap !== undefined && (
				<p className='notice'>Output gap through {gap}. Some terminal output is unavailable.</p>
			)}
			<div className='terminal-view' ref={element} />
		</section>
	);
};
