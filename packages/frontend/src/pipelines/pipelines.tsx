import { repositoryBranchesSchema } from "@forge/contracts";
import {
	pipelineDiscoverySchema,
	pipelineHistorySchema,
	pipelineRunSchema,
	type PipelineDiscovery,
	type PipelineRun,
	type PipelineRunSummary,
} from "@forge/contracts/pipelines";
import { useEffect, useRef, useState } from "react";

import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";

const active = (run: PipelineRun) => ["pending", "running"].includes(run.state);
const eventDefault = (events: string[]) =>
	events.includes("workflow_dispatch") ? "workflow_dispatch" : events.includes("push") ? "push" : (events[0] ?? "");
export function Pipelines({ projectId, api }: { projectId: string; api: IWorkspaceApi }) {
	const base = `projects/${projectId}`;
	const [branches, setBranches] = useState<string[]>([]);
	const [branch, setBranch] = useState("main");
	const [discovery, setDiscovery] = useState<PipelineDiscovery>();
	const [path, setPath] = useState("");
	const [event, setEvent] = useState("");
	const [runs, setRuns] = useState<PipelineRunSummary[]>([]);
	const [selected, setSelected] = useState<PipelineRun>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [offset, setOffset] = useState(0);
	const [hasMore, setHasMore] = useState(false);
	const poll = useRef<ResourcePoller<PipelineRun> | undefined>(undefined);
	const workflow = discovery?.workflows.find((workflow) => workflow.path === path);
	useEffect(() => {
		const abort = new AbortController();
		void api
			.read(`${base}/repository/branches`, repositoryBranchesSchema, "GET", undefined, abort.signal)
			.then((values) => {
				if (!abort.signal.aborted) setBranches(values.map((v) => v.name));
			})
			.catch((error: Error) => {
				if (!abort.signal.aborted) setError(error.message);
			});
		return () => abort.abort();
	}, [api, base]);
	useEffect(() => {
		const abort = new AbortController();
		void api
			.read(
				`${base}/pipelines?branch=${encodeURIComponent(branch)}`,
				pipelineDiscoverySchema,
				"GET",
				undefined,
				abort.signal,
			)
			.then((value) => {
				if (abort.signal.aborted) return;
				setDiscovery(value);
				setPath(value.workflows[0]?.path ?? "");
				setEvent(eventDefault(value.workflows[0]?.events ?? []));
			})
			.catch((error: Error) => {
				if (!abort.signal.aborted) setError(error.message);
			});
		return () => abort.abort();
	}, [api, base, branch]);
	useEffect(() => {
		const abort = new AbortController();
		void api
			.read(`${base}/pipeline-runs?offset=${offset}`, pipelineHistorySchema, "GET", undefined, abort.signal)
			.then(async (value) => {
				if (abort.signal.aborted) return;
				setRuns(value.runs);
				setHasMore(value.hasMore);
				if (value.runs[0]) {
					const detail = await api.read(
						`${base}/pipeline-runs/${value.runs[0].id}`,
						pipelineRunSchema,
						"GET",
						undefined,
						abort.signal,
					);
					if (!abort.signal.aborted) setSelected((selected) => selected ?? detail);
				}
			})
			.catch((error: Error) => {
				if (!abort.signal.aborted) setError(error.message);
			});
		return () => abort.abort();
	}, [api, base, offset]);
	const selectedId = selected?.id;
	const isActive = selected ? active(selected) : false;
	useEffect(() => {
		if (!selectedId || !isActive) return;
		const current = new ResourcePoller(
			(signal) => api.read(`${base}/pipeline-runs/${selectedId}`, pipelineRunSchema, "GET", undefined, signal),
			(value) => {
				setSelected(value);
				setRuns((runs) => runs.map((run) => (run.id === value.id ? value : run)));
				if (!active(value)) current.stop();
			},
			setError,
			2000,
		);
		poll.current = current;
		current.refresh();
		return () => {
			current.stop();
			poll.current = undefined;
		};
	}, [api, base, selectedId, isActive]);
	return (
		<section className='pipelines'>
			<h2>Pipelines</h2>
			<p>
				Run local GitHub Actions workflows manually. Events that need additional context may fail. Dispatch
				inputs use declared defaults.
			</p>
			{error && <p role='alert'>{error}</p>}
			<div className='pipeline-controls'>
				<label>
					Branch{" "}
					<select
						value={branch}
						onChange={(e) => {
							setDiscovery(undefined);
							setPath("");
							setEvent("");
							setError("");
							setBranch(e.target.value);
						}}
					>
						<option value='main'>main</option>
						{branches
							.filter((b) => b !== "main")
							.map((b) => (
								<option key={b}>{b}</option>
							))}
					</select>
				</label>
				<label>
					Pipeline{" "}
					<select
						value={path}
						onChange={(e) => {
							setPath(e.target.value);
							setEvent(
								eventDefault(discovery?.workflows.find((w) => w.path === e.target.value)?.events ?? []),
							);
						}}
					>
						<option value=''>Select pipeline</option>
						{discovery?.workflows.map((w) => (
							<option key={w.path} value={w.path}>
								{w.name} ({w.path.split("/").at(-1)})
							</option>
						))}
					</select>
				</label>
				<label>
					Event{" "}
					<select value={event} onChange={(e) => setEvent(e.target.value)}>
						{workflow?.events.map((value) => (
							<option key={value}>{value}</option>
						))}
					</select>
				</label>
				<button
					disabled={
						busy
						|| !workflow
						|| !event
						|| workflow.messages.some(
							(message) =>
								event === "workflow_dispatch" || !message.startsWith("workflow_dispatch requires"),
						)
					}
					onClick={() => {
						setBusy(true);
						setError("");
						void api
							.read(`${base}/pipeline-runs`, pipelineRunSchema, "POST", {
								branch,
								workflowPath: path,
								event,
							})
							.then((run) => {
								setSelected(run);
								setRuns((runs) => [run, ...runs].slice(0, 20));
								setOffset(0);
							})
							.catch((error: Error) => setError(error.message))
							.finally(() => setBusy(false));
					}}
				>
					Run
				</button>
			</div>
			{workflow?.messages.map((message) => (
				<p role='alert' key={message}>
					{message}
				</p>
			))}
			{discovery?.workflows.length === 0 && (
				<p>No workflows found on this branch. Add a YAML workflow under .github/workflows.</p>
			)}
			<h3>Recent runs</h3>
			{runs.length === 0 && <p>No pipeline runs yet.</p>}
			<ul>
				{runs.map((run) => (
					<li key={run.id}>
						<button
							onClick={() => {
								void api
									.read(`${base}/pipeline-runs/${run.id}`, pipelineRunSchema)
									.then(setSelected)
									.catch((error: Error) => setError(error.message));
							}}
						>
							{run.workflowName} · {run.branch} · {run.createdAt} · {run.state}
						</button>
					</li>
				))}
			</ul>
			{offset > 0 && <button onClick={() => setOffset(Math.max(0, offset - 20))}>Newer runs</button>}
			{hasMore && <button onClick={() => setOffset(offset + 20)}>Older runs</button>}
			{selected && (
				<section aria-label='Selected pipeline run'>
					<h3>{selected.workflowName}</h3>
					<p>
						Commit <code>{selected.commit}</code> ·{" "}
						<span className={`pipeline-state state-${selected.state}`}>{selected.state}</span>
					</p>
					{selected.failure && <p role='alert'>{selected.failure}</p>}
					{selected.jobs.map((job) => (
						<section key={`${job.id}:${JSON.stringify(job.matrix)}`}>
							<h4>
								{job.name} ({job.id}) {Object.keys(job.matrix).length > 0 && JSON.stringify(job.matrix)}{" "}
								· {job.state}
							</h4>
							<ol>
								{[...job.steps]
									.sort(
										(a, b) =>
											({ Pre: 0, Main: 1, Post: 2 }[a.phase] ?? 1)
												- ({ Pre: 0, Main: 1, Post: 2 }[b.phase] ?? 1) || a.order - b.order,
									)
									.map((step) => (
										<li key={`${step.phase}:${step.id}`}>
											<span className={`pipeline-state state-${step.state}`}>{step.state}</span> ·{" "}
											{step.name} ({step.id}){step.phase !== "Main" && ` · ${step.phase}`}
										</li>
									))}
							</ol>
						</section>
					))}
				</section>
			)}
		</section>
	);
}
