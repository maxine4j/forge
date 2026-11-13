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
import { Dropdown, DropdownOption } from "../dropdown.tsx";
import { useErrorState, useFailureToast } from "../toasts/toasts.tsx";

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
	const [, setError] = useErrorState();
	const [busy, setBusy] = useState(false);
	const [offset, setOffset] = useState(0);
	const [hasMore, setHasMore] = useState(false);
	const poll = useRef<ResourcePoller<PipelineRun> | undefined>(undefined);
	const selectionRequest = useRef<AbortController | undefined>(undefined);
	useEffect(() => () => selectionRequest.current?.abort(), []);
	const workflow = discovery?.workflows.find((workflow) => workflow.path === path);
	useFailureToast(workflow?.messages.join(" "));
	useFailureToast(selected?.failure, selected?.id);
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
	}, [api, base, setError]);
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
	}, [api, base, branch, setError]);
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
	}, [api, base, offset, setError]);
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
	}, [api, base, selectedId, isActive, setError]);
	return (
		<section className='pipelines'>
			<h2>Pipelines</h2>
			<p>
				Run local GitHub Actions workflows manually. Events that need additional context may fail. Dispatch
				inputs use declared defaults.
			</p>

			<div className='pipeline-controls'>
				<label>
					Branch{" "}
					<Dropdown
						aria-label='Branch'
						value={branch}
						onChange={(value) => {
							setDiscovery(undefined);
							setPath("");
							setEvent("");
							setError("");
							setBranch(value);
						}}
					>
						<DropdownOption value='main'>main</DropdownOption>
						{branches
							.filter((b) => b !== "main")
							.map((b) => (
								<DropdownOption key={b}>{b}</DropdownOption>
							))}
					</Dropdown>
				</label>
				<label>
					Pipeline{" "}
					<Dropdown
						aria-label='Pipeline'
						value={path}
						onChange={(value) => {
							setPath(value);
							setEvent(eventDefault(discovery?.workflows.find((w) => w.path === value)?.events ?? []));
						}}
					>
						<DropdownOption value=''>Select pipeline</DropdownOption>
						{discovery?.workflows.map((w) => (
							<DropdownOption key={w.path} value={w.path}>
								{w.name} ({w.path.split("/").at(-1)})
							</DropdownOption>
						))}
					</Dropdown>
				</label>
				<label>
					Event{" "}
					<Dropdown aria-label='Event' value={event} onChange={(value) => setEvent(value)}>
						{workflow?.events.map((value) => (
							<DropdownOption key={value}>{value}</DropdownOption>
						))}
					</Dropdown>
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
						selectionRequest.current?.abort();
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
								selectionRequest.current?.abort();
								const request = new AbortController();
								selectionRequest.current = request;
								void api
									.read(
										`${base}/pipeline-runs/${run.id}`,
										pipelineRunSchema,
										"GET",
										undefined,
										request.signal,
									)
									.then((value) => {
										if (!request.signal.aborted) setSelected(value);
									})
									.catch((error: Error) => {
										if (!request.signal.aborted) setError(error.message);
									});
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
