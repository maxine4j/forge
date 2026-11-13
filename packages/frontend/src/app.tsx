import type { AccountProvider, AccountStatus, AccountsStatus, Project } from "@forge/contracts";
import { createProjectSchema } from "@forge/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link, Navigate, useBlocker, useLocation } from "react-router";

import { AgentOptionsRevision } from "./agents/execution-settings.tsx";
import type { IApiClient } from "./api/api-client.ts";
import { ResourcePoller } from "./api/resource-poller.ts";
import type { IWorkspaceApi } from "./api/workspace-api.ts";
import { CostDashboard } from "./cost/cost-dashboard.tsx";
import { InterfaceIcon } from "./navigation/interface-icon.tsx";
import { resolveRoute } from "./navigation/routes.ts";
import { ForgeSettingsForm } from "./settings/settings-form.tsx";
import { Tasks } from "./tasks/tasks.tsx";
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
						<p className='notice'>Account connection unavailable. Repository access is still available.</p>
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
							<button type='button' disabled={busy} onClick={() => action("cancel")}>
								Cancel sign-in
							</button>
						) : (
							<button
								type='button'
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
							<button type='button' disabled={busy} onClick={() => action("cancel")}>
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
	const constrained = route.page === "tasks" || (route.page === "repo" && route.section === "agents");
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
	const global = config || route.page === "costs" || route.page === "tasks";
	const [retained, setRetained] = useState<Project>();
	const [projects, setProjects] = useState<Project[]>();
	const selected = global
		? retained
		: route.page === "repo"
			? projects?.find((project) => project.id === route.repositoryId && project.status === "ready")
			: undefined;
	if (!global && retained !== selected) setRetained(selected);
	const [dirty, setDirty] = useState(false);
	const dirtyChange = useCallback((value: boolean) => setDirty(value), []);
	const [navigationError, setNavigationError] = useState("");
	const blocker = useBlocker(({ nextLocation }) => {
		const next = resolveRoute(nextLocation.pathname);
		const blocked =
			dirty
			&& next.page !== "config"
			&& next.page !== "costs"
			&& next.page !== "tasks"
			&& !(next.page === "repo" && next.repositoryId === selected?.id);
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
	const [createError, setCreateError] = useState("");
	const [projectBusy, setProjectBusy] = useState(false);
	const [accountBusy, setAccountBusy] = useState(false);
	const [agentOptionsRevision, setAgentOptionsRevision] = useState(0);
	const projectPoller = useRef<ResourcePoller<Project[]> | undefined>(undefined);
	const createDialog = useRef<HTMLDialogElement>(null);
	const projectName = useRef<HTMLInputElement>(null);
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
	const openCreateDialog = () => {
		setName("");
		setSource("");
		setCreateError("");
		createDialog.current?.showModal();
		projectName.current?.focus();
	};
	const create = async (event: FormEvent) => {
		event.preventDefault();
		if (projectBusy) return;
		const input = createProjectSchema.safeParse({ name, ...(source.trim() ? { source: source.trim() } : {}) });
		if (!input.success) {
			setCreateError("Enter a repository name (up to 120 characters) and a credential-free HTTPS import URL.");
			return;
		}
		const dialog = createDialog.current;
		let created = false;
		setCreateError("");
		setProjectBusy(true);
		await projectPoller.current?.mutate(async (signal) => {
			try {
				const project = await api.create(input.data, signal);
				created = !signal.aborted;
				return api.projects(signal).catch(() => [...(projects ?? []), project]);
			} catch (error) {
				if (!signal.aborted)
					setCreateError(error instanceof Error ? error.message : "Repository operation failed. Try again.");
				return api.projects(signal);
			}
		});
		setProjectBusy(false);
		if (created && dialog?.open) dialog.close();
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
			{location.pathname === "/" && <Navigate to='/tasks' replace />}
			<header>
				<Link className='brand' to='/tasks' aria-label='Forge home'>
					<img src='/assets/anvil.svg' alt='' width={32} height={32} />
					forge
				</Link>
				<nav className='global-nav' aria-label='Forge'>
					<Link to='/tasks' aria-current={route.page === "tasks" ? "page" : undefined}>
						<InterfaceIcon name='tasks' />
						Tasks
					</Link>
					<Link
						to='/repos'
						aria-current={route.page === "repos" || route.page === "repo" ? "page" : undefined}
					>
						<InterfaceIcon name='repos' />
						Repos
					</Link>
					<Link to='/costs' aria-current={route.page === "costs" ? "page" : undefined}>
						<InterfaceIcon name='costs' />
						Costs
					</Link>
					<Link to='/config' aria-current={config ? "page" : undefined}>
						<InterfaceIcon name='settings' />
						Config
					</Link>
				</nav>
			</header>
			<main>
				<div className='tasks-view' hidden={route.page !== "tasks"}>
					<AgentOptionsRevision.Provider value={agentOptionsRevision}>
						<Tasks api={workspaceApi} visible={route.page === "tasks"} />
					</AgentOptionsRevision.Provider>
				</div>
				{route.page === "costs" && <CostDashboard api={workspaceApi} />}
				{navigationError && dirty && (
					<p role='alert' className='error'>
						{navigationError}
					</p>
				)}
				{route.page === "not-found" && (
					<section>
						<h1>Page not found</h1>
						<Link to='/repos'>View repos</Link>
					</section>
				)}
				{route.page === "repo" && !selected && (
					<section>
						<h1>{!projects && !projectError ? "Loading repository…" : "Repository unavailable"}</h1>
						{projectError && <p role='alert'>{projectError}</p>}
						<Link to='/repos'>View repos</Link>
					</section>
				)}
				{selected && (
					<div className='project-view' hidden={global}>
						<AgentOptionsRevision.Provider value={agentOptionsRevision}>
							<Workbench
								key={selected.id}
								project={selected}
								api={workspaceApi}
								dirtyChange={dirtyChange}
							/>
						</AgentOptionsRevision.Provider>
					</div>
				)}
				{route.page === "repos" && (
					<section aria-labelledby='projects-heading' className='projects-section'>
						<div className='section-heading'>
							<h2 id='projects-heading'>
								Repos <span className='count'>{projects?.length ?? "—"}</span>
							</h2>
							<button className='primary' type='button' onClick={openCreateDialog}>
								Create repo
							</button>
						</div>
						{projectError && (
							<p role='alert' className='error'>
								{projectError}
							</p>
						)}
						{!projects ? (
							<div className='empty'>Loading repositories…</div>
						) : projects.length === 0 ? (
							<div className='empty'>
								<span aria-hidden='true'>＋</span>
								<h3>No repos yet</h3>
								<p>
									Your repositories will live here.
									<br />
									Create your first repository to get started.
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
											to={`/repos/${project.id}/code`}
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
						<dialog
							ref={createDialog}
							className='ticket-dialog'
							aria-labelledby='create-heading'
							onCancel={(event) => {
								if (projectBusy) event.preventDefault();
							}}
						>
							<div className='ticket-dialog-heading'>
								<h2 id='create-heading'>New repository</h2>
								<button
									type='button'
									aria-label='Close repository form'
									disabled={projectBusy}
									onClick={() => createDialog.current?.close()}
								>
									✕
								</button>
							</div>
							<form onSubmit={(event) => void create(event)}>
								<label>
									Repository name
									<input
										ref={projectName}
										value={name}
										onChange={(event) => setName(event.target.value)}
										required
										maxLength={120}
										placeholder='e.g. homelab-dashboard'
										disabled={projectBusy}
									/>
								</label>
								<label>
									<strong>
										Import repository <span>(optional)</span>
									</strong>
									<input
										type='url'
										value={source}
										onChange={(event) => setSource(event.target.value)}
										maxLength={2048}
										placeholder='https://github.com/owner/repo.git'
										aria-describedby='project-source-help'
										disabled={projectBusy}
									/>
								</label>
								<small id='project-source-help'>
									Public HTTPS repositories from operator-approved hosts. Leave blank for an empty
									repository.
								</small>
								{createError && (
									<p role='alert' className='error'>
										{createError}
									</p>
								)}
								<div className='ticket-dialog-actions'>
									<button className='primary' disabled={projectBusy} type='submit'>
										{projectBusy ? "Creating repository…" : "Create repository"}
									</button>
								</div>
							</form>
						</dialog>
					</section>
				)}
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
					{accountError && (
						<p role='alert' className='error'>
							{accountError}
						</p>
					)}
				</section>
				{config && (
					<ForgeSettingsForm
						api={workspaceApi}
						githubAccount={
							<AccountCard
								provider='github'
								status={accounts?.github}
								busy={accountBusy}
								action={(action) => void accountAction("github", action)}
							/>
						}
						chatgptAccount={
							<AccountCard
								provider='codex'
								status={accounts?.codex}
								busy={accountBusy}
								action={(action) => void accountAction("codex", action)}
							/>
						}
						defaultsSaved={() => setAgentOptionsRevision((revision) => revision + 1)}
					/>
				)}
			</main>
		</div>
	);
};
