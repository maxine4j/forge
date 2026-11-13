import {
	dockerOperationSchema,
	dockerOverviewSchema,
	type DockerOperation,
	type DockerOverview,
} from "@forge/contracts/docker";
import { useEffect, useRef, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { useErrorState, useFailureToast } from "../toasts/toasts.tsx";

export const DockerSettings = ({ api }: { api: IWorkspaceApi }) => {
	const [overview, setOverview] = useState<DockerOverview>();
	const [operation, setOperation] = useState<DockerOperation | null>(null);
	const [error, setError] = useErrorState();
	const [busy, setBusy] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const refresh = useRef<() => void>(() => {});
	const mutation = useRef<AbortController | undefined>(undefined);
	const revision = useRef(0);
	useEffect(() => {
		let active = true;
		let pending = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let request: AbortController | undefined;
		const poll = async () => {
			if (!active || pending || document.visibilityState !== "visible") return;
			clearTimeout(timer);
			pending = true;
			setRefreshing(true);
			request = new AbortController();
			const startedRevision = revision.current;
			try {
				const value = await api.read("board/docker", dockerOverviewSchema, "GET", undefined, request.signal);
				if (active && startedRevision === revision.current) {
					setOverview(value);
					setOperation(value.operation);
					setError("");
				}
			} catch {
				if (active) setError("Docker status unavailable. Displayed statistics may be stale. Refresh to retry.");
			} finally {
				pending = false;
				if (active) {
					setRefreshing(false);
					if (document.visibilityState === "visible") timer = setTimeout(() => void poll(), 5000);
				}
			}
		};
		refresh.current = () => void poll();
		const visibility = () => {
			clearTimeout(timer);
			if (document.visibilityState === "visible") void poll();
		};
		document.addEventListener("visibilitychange", visibility);
		void poll();
		return () => {
			active = false;
			clearTimeout(timer);
			request?.abort();
			mutation.current?.abort();
			document.removeEventListener("visibilitychange", visibility);
		};
	}, [api, setError]);
	const cleanup = async (target: string) => {
		revision.current++;
		setBusy(true);
		setError("");
		const controller = new AbortController();
		mutation.current = controller;
		try {
			const path = target === "all" ? "board/docker/cleanup" : `board/docker/containers/${target}/cleanup`;
			const value = await api.read(path, dockerOperationSchema, "POST", undefined, controller.signal);
			if (!controller.signal.aborted) setOperation(value);
		} catch (failure) {
			if (!controller.signal.aborted)
				setError(failure instanceof Error ? failure.message : "Cleanup request failed. Refresh and retry.");
		} finally {
			if (!controller.signal.aborted) setBusy(false);
		}
	};
	useFailureToast(
		overview && !overview.available ? "Docker unavailable. Board and agent controls remain available." : undefined,
	);
	useFailureToast(operation?.failures.join(" "), operation?.id);
	const cleaning = busy || operation?.status === "running";
	return (
		<section className='docker-settings' aria-label='Docker containers'>
			<h3>Docker containers</h3>
			<p>
				Docker workload data is disposable. Global cleanup leaves agents running and ticket dispatch unchanged.
			</p>
			<div className='board-settings-actions'>
				<button type='button' disabled={refreshing} onClick={() => refresh.current()}>
					Refresh Docker
				</button>
				<button type='button' disabled={cleaning || !overview?.available} onClick={() => void cleanup("all")}>
					Kill all and clean Docker
				</button>
			</div>
			{!overview && !error && <p role='status'>Loading Docker…</p>}

			{overview?.available && (
				<>
					{overview.statisticsStale && <p role='status'>Statistics are stale or unavailable.</p>}
					{overview.statisticsAt && (
						<p>Latest statistics: {new Date(overview.statisticsAt).toLocaleTimeString()}</p>
					)}
					{overview.containers.length === 0 && (
						<p>No running containers. Images, stopped containers, volumes and build cache may remain.</p>
					)}
					{overview.containers.map((item) => (
						<article key={item.id} className='docker-container'>
							<h4>
								{item.name} <code>{item.id.slice(0, 12)}</code>
							</h4>
							<p>
								{item.image} · {item.status} · Ports: {item.ports || "none"}
							</p>
							{item.stats ? (
								<dl>
									<dt>CPU</dt>
									<dd>{item.stats.cpu}</dd>
									<dt>Memory usage / limit</dt>
									<dd>{item.stats.memory}</dd>
									<dt>Network I/O</dt>
									<dd>{item.stats.network}</dd>
									<dt>Block I/O</dt>
									<dd>{item.stats.block}</dd>
									<dt>Processes</dt>
									<dd>{item.stats.processes}</dd>
								</dl>
							) : (
								<p>Statistics unavailable for this container.</p>
							)}
							<button type='button' disabled={cleaning} onClick={() => void cleanup(item.id)}>
								Kill and clean up
							</button>
						</article>
					))}
				</>
			)}
			{operation && (
				<div role='status'>
					<p>
						Cleanup {operation.status}: {operation.progress}
					</p>
					{operation.retained.length > 0 && (
						<>
							<p>Retained shared resources:</p>
							<ul>
								{operation.retained.map((resource, index) => (
									<li key={index}>{resource}</li>
								))}
							</ul>
						</>
					)}
					{operation.remaining && (
						<p>
							Remaining: {operation.remaining.containers.length} containers,{" "}
							{operation.remaining.images.length} images, {operation.remaining.volumes.length} volumes,{" "}
							{operation.remaining.networks.length} custom networks. Build cache:{" "}
							{operation.remaining.buildCache.join(", ") || "none"}.
						</p>
					)}
					{operation.status === "partial" && (
						<button
							type='button'
							disabled={cleaning || !overview?.available}
							onClick={() => void cleanup(operation.target)}
						>
							Retry Docker cleanup
						</button>
					)}
				</div>
			)}
		</section>
	);
};
