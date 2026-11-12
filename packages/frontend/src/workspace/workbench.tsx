import { workspaceSchema, workspacesSchema, type Project, type Workspace } from "@forge/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";

import { AgentChat } from "../agents/agent-chat.tsx";
import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { resolveRoute } from "../navigation/routes.ts";
import { Pipelines } from "../pipelines/pipelines.tsx";
import { RepositoryBrowser } from "./repository-browser.tsx";
import { WorkspaceTerminal } from "./terminal.tsx";

const ProjectTerminal = ({ projectId, api }: { projectId: string; api: IWorkspaceApi }) => {
	const [workspace, setWorkspace] = useState<Workspace>();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const preparing = useRef<Promise<Workspace> | undefined>(undefined);
	const prepare = useCallback(async () => {
		const values = await api.read(`projects/${projectId}/workspaces`, workspacesSchema);
		return (
			values.find((value) => value.name === "Repository files" && value.status !== "archived")
			?? values.find((value) => value.status !== "archived")
			?? api.read(`projects/${projectId}/workspaces`, workspaceSchema, "POST", { name: "Repository files" })
		);
	}, [api, projectId]);
	useEffect(() => {
		let cancelled = false;
		preparing.current ??= prepare();
		void preparing.current
			.then((value) => {
				if (!cancelled) setWorkspace(value);
			})
			.catch(() => {
				if (!cancelled) setError("Terminal files unavailable.");
			});
		return () => {
			cancelled = true;
		};
	}, [prepare]);
	if (workspace?.status === "ready") return <WorkspaceTerminal id={workspace.id} api={api} />;
	return (
		<section>
			{error && <p role='alert'>{error}</p>}
			{workspace?.status === "failed" || error ? (
				<button
					disabled={busy}
					onClick={() => {
						setBusy(true);
						setError("");
						void (
							workspace?.status === "failed"
								? api.read(`workspaces/${workspace.id}/retry`, workspaceSchema, "POST", {})
								: prepare()
						)
							.then(setWorkspace)
							.catch(() => setError("Terminal files unavailable."))
							.finally(() => setBusy(false));
					}}
				>
					Retry opening files
				</button>
			) : (
				<p role='status'>Preparing terminal files…</p>
			)}
		</section>
	);
};

export const Workbench = ({
	project,
	api,
	dirtyChange: reportDirty,
}: {
	project: Project;
	api: IWorkspaceApi;
	dirtyChange: (dirty: boolean) => void;
}) => {
	const location = useLocation();
	const route = resolveRoute(location.pathname);
	const [navigation, setNavigation] = useState<{
		section: string;
		locations: Record<string, string>;
		opened: string[];
	}>({ section: "code", locations: {}, opened: [] });
	const section = route.page === "repo" ? route.section : navigation.section;
	const url = location.pathname + location.search;
	if (route.page === "repo" && navigation.locations[section] !== url) {
		setNavigation({
			section,
			locations: { ...navigation.locations, [section]: url },
			opened: navigation.opened.includes(section) ? navigation.opened : [...navigation.opened, section],
		});
	}
	const tab = section.charAt(0).toUpperCase() + section.slice(1);
	const codePath = `/repos/${project.id}/code`;
	const codeSearch = new URLSearchParams(navigation.locations["code"]?.split("?").at(1));
	const filesSearch = new URLSearchParams();
	for (const key of ["branch", "path"]) {
		const value = codeSearch.get(key);
		if (value) filesSearch.set(key, value);
	}
	const codeFiles = filesSearch.size ? `${codePath}?${filesSearch}` : codePath;
	const [dirtyBranches, setDirtyBranches] = useState<Record<string, boolean>>({});
	const dirty = Object.values(dirtyBranches).some(Boolean);
	useEffect(() => {
		reportDirty(dirty);
	}, [dirty, reportDirty]);
	const dirtyChange = useCallback((branch: string, value: boolean) => {
		setDirtyBranches((current) => (current[branch] === value ? current : { ...current, [branch]: value }));
	}, []);
	useEffect(() => {
		const guard = (event: BeforeUnloadEvent) => {
			if (dirty) event.preventDefault();
		};
		window.addEventListener("beforeunload", guard);
		return () => window.removeEventListener("beforeunload", guard);
	}, [dirty]);
	return (
		<section className='workbench' aria-label='Repository'>
			<div className='project-tabs' role='tablist' aria-label='Repository sections'>
				{["Code", "Agents", "Pipelines", "Terminals"].map((name) => (
					<Link
						key={name}
						id={`tab-${name}`}
						role='tab'
						aria-selected={tab === name}
						aria-controls={`panel-${name}`}
						to={
							name === "Code"
								? codeFiles
								: (navigation.locations[name.toLowerCase()]
									?? `/repos/${project.id}/${name.toLowerCase()}`)
						}
					>
						{name}
					</Link>
				))}
			</div>
			<section id='panel-Code' role='tabpanel' aria-labelledby='tab-Code' hidden={tab !== "Code"}>
				<RepositoryBrowser
					projectId={project.id}
					repositoryName={project.name}
					githubSyncAvailable={project.githubSyncAvailable === true}
					api={api}
					dirtyChange={dirtyChange}
				/>
			</section>
			<section id='panel-Agents' role='tabpanel' aria-labelledby='tab-Agents' hidden={tab !== "Agents"}>
				{navigation.opened.includes("agents") && <AgentChat projectId={project.id} api={api} />}
			</section>
			<section id='panel-Pipelines' role='tabpanel' aria-labelledby='tab-Pipelines' hidden={tab !== "Pipelines"}>
				{tab === "Pipelines" && <Pipelines key={project.id} projectId={project.id} api={api} />}
			</section>
			<section id='panel-Terminals' role='tabpanel' aria-labelledby='tab-Terminals' hidden={tab !== "Terminals"}>
				{navigation.opened.includes("terminals") && <ProjectTerminal projectId={project.id} api={api} />}
			</section>
		</section>
	);
};
