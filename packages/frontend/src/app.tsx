import type { AccountProvider, AccountStatus, AccountsStatus, Project } from "@forge/contracts";
import { createProjectSchema } from "@forge/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, Navigate, useBlocker, useLocation } from "react-router";

import type { IApiClient } from "./api/api-client.ts";
import { ResourcePoller } from "./api/resource-poller.ts";
import type { IWorkspaceApi } from "./api/workspace-api.ts";
import { resolveRoute } from "./navigation/routes.ts";
import { Workbench } from "./workspace/workbench.tsx";

const failureMessages = {
	unavailable: "Check the CLI installation and credential-home permissions on the server.",
	"verification-failed": "Check connectivity and account access, then refresh or retry sign-in.",
	"login-failed": "Request a fresh code and check your provider's device-login settings.",
	"connection-lost":
		"Previous sign-in outcome is unknown. Refresh to verify the account, then explicitly cancel or retry.",
};

const AccountCard = ({
	provider,
	status,
	busy,
	action,
}: {
	provider: AccountProvider;
	status?: AccountStatus;
	busy: boolean;
	action: (action: "login" | "retry" | "cancel") => void;
}) => {
	const title = provider === "codex" ? "ChatGPT" : "GitHub";
	return (
		<section className='account-card' aria-label={title}>
			<div className='card-top'>
				<span className='provider-icon' aria-hidden='true'>
					{provider === "codex" ? "✳" : "⑂"}
				</span>
				<div>
					<h3>{title}</h3>
					<p>{provider === "codex" ? "Codex account" : "Repository access"}</p>
				</div>
				<span className={`dot ${status?.account ? "connected" : ""}`} />
			</div>
			{!status ? (
				<p>Checking account…</p>
			) : (
				<>
					<p className='account-name'>{status.account ? status.account.name : "Not signed in"}</p>
					{status.connection === "unavailable" && (
						<p className='notice'>Account connection unavailable. Project access is still available.</p>
					)}
					{status.login.failure && <p className='notice'>{failureMessages[status.login.failure]}</p>}
					{status.login.state === "pending" && (
						<div className='device-code'>
							<span>Enter this one-time code</span>
							<strong>{status.login.userCode}</strong>
							<a href={status.login.verificationUrl} target='_blank' rel='noopener noreferrer'>
								Open verification page <span aria-hidden='true'>↗</span>
							</a>
							<small>Waiting for account verification…</small>
						</div>
					)}
					{status.login.state === "completed" && <p className='success'>Account verified.</p>}
					{status.login.state === "cancelled" && <p>Sign-in cancelled.</p>}
					<div className='account-actions'>
						{status.login.state === "pending" ? (
							<button disabled={busy} onClick={() => action("cancel")}>
								Cancel sign-in
							</button>
						) : (
							<button
								disabled={busy}
								onClick={() =>
									action(
										["failed", "uncertain", "cancelled"].includes(status.login.state)
											? "retry"
											: "login",
									)
								}
							>
								{busy
									? "Working…"
									: ["failed", "uncertain", "cancelled"].includes(status.login.state)
										? "Retry sign-in"
										: status.account
											? "Sign in again"
											: "Sign in"}
							</button>
						)}
						{status.login.state === "uncertain" && (
							<button disabled={busy} onClick={() => action("cancel")}>
								Cancel sign-in
							</button>
						)}
					</div>
				</>
			)}
		</section>
	);
};

export const App = ({ api, workspaceApi }: { api: IApiClient; workspaceApi: IWorkspaceApi }) => {
	const location = useLocation();
	const route = resolveRoute(location.pathname);
	const constrained = route.page === "project" && (route.section === "agents" || route.section === "tasks");
	const [viewport, setViewport] = useState({ height: window.visualViewport?.height ?? window.innerHeight, top: 0 });
	useEffect(() => {
		if (!constrained) return;
		const update = () =>
			setViewport({
				height: window.visualViewport?.height ?? window.innerHeight,
				top: window.visualViewport?.offsetTop ?? 0,
			});
		update();
		window.visualViewport?.addEventListener("resize", update);
		window.visualViewport?.addEventListener("scroll", update);
		window.addEventListener("resize", update);
		return () => {
			window.visualViewport?.removeEventListener("resize", update);
			window.visualViewport?.removeEventListener("scroll", update);
			window.removeEventListener("resize", update);
		};
	}, [constrained]);
	const config = route.page === "config";
	const [retained, setRetained] = useState<Project>();
	const [projects, setProjects] = useState<Project[]>();
	const selected = config
		? retained
		: route.page === "project"
			? projects?.find((project) => project.id === route.projectId && project.status === "ready")
			: undefined;
	if (!config && retained !== selected) setRetained(selected);
	const [dirty, setDirty] = useState(false);
	const dirtyChange = useCallback((value: boolean) => setDirty(value), []);
	const [navigationError, setNavigationError] = useState("");
	const blocker = useBlocker(({ nextLocation }) => {
		const next = resolveRoute(nextLocation.pathname);
		const blocked =
			dirty && next.page !== "config" && !(next.page === "project" && next.projectId === selected?.id);
		if (blocked) setNavigationError("Uncommitted drafts remain. Commit or discard them before leaving.");
		return blocked;
	});
	useEffect(() => {
		if (blocker.state === "blocked") {
			blocker.reset();
		}
	}, [blocker]);
	const [accounts, setAccounts] = useState<AccountsStatus>();
	const [projectError, setProjectError] = useState("");
	const [accountError, setAccountError] = useState("");
	const [name, setName] = useState("");
	const [source, setSource] = useState("");
	const [projectBusy, setProjectBusy] = useState(false);
	const [accountBusy, setAccountBusy] = useState(false);
	const projectPoller = useRef<ResourcePoller<Project[]> | undefined>(undefined);
	const accountPoller = useRef<ResourcePoller<AccountsStatus> | undefined>(undefined);
	useEffect(() => {
		const project = new ResourcePoller(
			(signal) => api.projects(signal),
			(value) => {
				setProjects(value);
				setProjectError("");
			},
			setProjectError,
		);
		const account = new ResourcePoller(
			(signal) => api.accounts(signal),
			(value) => {
				setAccounts(value);
				setAccountError("");
			},
			setAccountError,
		);
		projectPoller.current = project;
		accountPoller.current = account;
		project.refresh();
		account.refresh();
		return () => {
			project.stop();
			account.stop();
		};
	}, [api]);
	const create = async (event: FormEvent) => {
		event.preventDefault();
		const input = createProjectSchema.safeParse({ name, ...(source.trim() ? { source: source.trim() } : {}) });
		if (!input.success) {
			setProjectError("Enter a project name (up to 120 characters) and a credential-free HTTPS import URL.");
			return;
		}
		setProjectBusy(true);
		await projectPoller.current?.mutate(async (signal) => {
			try {
				const project = await api.create(input.data, signal);
				if (!signal.aborted) {
					setName("");
					setSource("");
				}
				return api.projects(signal).catch(() => [...(projects ?? []), project]);
			} catch (error) {
				const current = await api.projects(signal).catch(() => undefined);
				if (current && !signal.aborted) setProjects(current);
				throw error;
			}
		});
		setProjectBusy(false);
	};
	const retry = async (id: string) => {
		setProjectBusy(true);
		await projectPoller.current?.mutate(async (signal) => {
			const project = await api.retry(id, signal);
			return (projects ?? []).map((item) => (item.id === id ? project : item));
		});
		setProjectBusy(false);
	};
	const accountAction = async (provider: AccountProvider, action: "login" | "retry" | "cancel") => {
		setAccountBusy(true);
		await accountPoller.current?.mutate(async (signal) => {
			const status = await api.account(provider, action, signal);
			const current = accounts ?? (await api.accounts(signal));
			return { ...current, [provider]: status };
		});
		setAccountBusy(false);
	};
	return (
		<div className={`shell${constrained ? " shell-constrained" : ""}`}>
			{constrained && (
				<style>{`.shell-constrained { height: ${viewport.height}px; top: ${viewport.top}px; --forge-viewport-height: ${viewport.height}px; --forge-viewport-top: ${viewport.top}px; }`}</style>
			)}
			{location.pathname === "/" && <Navigate to='/projects' replace />}
			<header>
				<div className='header-identity'>
					<Link className='brand' to='/projects' aria-label='Forge home'>
						<span aria-hidden='true'>F</span>forge
					</Link>
					{selected && !config && (
						<>
							<span className='header-separator' aria-hidden='true'>
								/
							</span>
							<h1 className='header-project' title={selected.name}>
								{selected.name}
							</h1>
						</>
					)}
				</div>
				<nav className='global-nav' aria-label='Forge'>
					<Link to='/projects' aria-current={!config ? "page" : undefined}>
						Projects
					</Link>
					<Link to='/config' aria-current={config ? "page" : undefined}>
						Config
					</Link>
				</nav>
			</header>
			<main>
				{navigationError && dirty && (
					<p role='alert' className='error'>
						{navigationError}
					</p>
				)}
				{route.page === "not-found" && (
					<section>
						<h1>Page not found</h1>
						<Link to='/projects'>View projects</Link>
					</section>
				)}
				{route.page === "project" && !selected && (
					<section>
						<h1>{!projects && !projectError ? "Loading project…" : "Project unavailable"}</h1>
						{projectError && <p role='alert'>{projectError}</p>}
						<Link to='/projects'>View projects</Link>
					</section>
				)}
				<div className='intro' hidden={route.page !== "projects"}>
					<div>
						<h1>Your projects</h1>
						<p>Build, review, and ship from one place.</p>
					</div>
				</div>
				{selected && (
					<div className='project-view' hidden={config}>
						<Workbench key={selected.id} project={selected} api={workspaceApi} dirtyChange={dirtyChange} />
					</div>
				)}
				<div className='workspace-grid' hidden={route.page !== "projects"}>
					<section aria-labelledby='projects-heading' className='projects-section'>
						<div className='section-heading'>
							<div>
								<h2 id='projects-heading'>
									Projects <span className='count'>{projects?.length ?? "—"}</span>
								</h2>
							</div>
							<button
								className='quiet'
								onClick={() => projectPoller.current?.refresh()}
								disabled={projectBusy}
							>
								Refresh projects
							</button>
						</div>
						{projectError && (
							<p role='alert' className='error'>
								{projectError}
							</p>
						)}
						{!projects ? (
							<div className='empty'>Loading projects…</div>
						) : projects.length === 0 ? (
							<div className='empty'>
								<span aria-hidden='true'>＋</span>
								<h3>No projects yet</h3>
								<p>
									Your repositories will live here.
									<br />
									Create your first project to get started.
								</p>
							</div>
						) : (
							<div className='project-list'>
								{projects.map((project) => {
									const card = (
										<article className='project' key={project.id}>
											<div className='repo-icon' aria-hidden='true'>
												⑂
											</div>
											<div className='project-info'>
												<h3>{project.name}</h3>
												<p>
													Created{" "}
													{new Date(project.createdAt).toLocaleDateString(undefined, {
														month: "short",
														day: "numeric",
														year: "numeric",
													})}
												</p>
											</div>
											<span className={`status ${project.status}`}>
												{project.status === "ready"
													? "Ready"
													: project.status === "creating"
														? "Creating"
														: "Failed"}
											</span>
											{project.status === "failed" && (
												<button
													disabled={projectBusy}
													aria-label={`Retry ${project.name}`}
													onClick={() => void retry(project.id)}
												>
													Retry
												</button>
											)}
										</article>
									);
									return project.status === "ready" ? (
										<Link
											key={project.id}
											className='project-link'
											to={`/projects/${project.id}/code`}
											aria-label={`Open ${project.name}`}
										>
											{card}
										</Link>
									) : (
										card
									);
								})}
							</div>
						)}
					</section>
					<section className='create-card' aria-labelledby='create-heading'>
						<h2 id='create-heading'>New project</h2>
						<p>A fresh repository, or a new home for existing code.</p>
						<form onSubmit={(event) => void create(event)}>
							<label htmlFor='project-name'>Project name</label>
							<input
								id='project-name'
								value={name}
								onChange={(event) => setName(event.target.value)}
								required
								maxLength={120}
								placeholder='e.g. homelab-dashboard'
								disabled={projectBusy}
							/>
							<label htmlFor='project-source'>
								Import repository <span>(optional)</span>
							</label>
							<input
								id='project-source'
								type='url'
								value={source}
								onChange={(event) => setSource(event.target.value)}
								maxLength={2048}
								placeholder='https://github.com/owner/repo.git'
								disabled={projectBusy}
							/>
							<small>
								Public HTTPS repositories from operator-approved hosts. Leave blank for an empty
								repository.
							</small>
							<button className='primary' disabled={projectBusy} type='submit'>
								{projectBusy ? "Creating project…" : "Create project"}
								<span aria-hidden='true'>↗</span>
							</button>
						</form>
					</section>
				</div>
				<section className='accounts-section' aria-labelledby='accounts-heading' hidden={!config}>
					<div className='section-heading'>
						<div>
							<h1 id='accounts-heading'>Config</h1>
						</div>
						<button
							className='quiet'
							disabled={accountBusy}
							onClick={() => accountPoller.current?.refresh()}
						>
							Refresh accounts
						</button>
					</div>
					<p className='accounts-description'>Connect ChatGPT for agents and GitHub for repository access.</p>
					{accountError && (
						<p role='alert' className='error'>
							{accountError}
						</p>
					)}
					<div className='account-grid'>
						{(["codex", "github"] as const).map((provider) => (
							<AccountCard
								key={provider}
								provider={provider}
								status={accounts?.[provider]}
								busy={accountBusy}
								action={(action) => void accountAction(provider, action)}
							/>
						))}
					</div>
				</section>
			</main>
		</div>
	);
};
