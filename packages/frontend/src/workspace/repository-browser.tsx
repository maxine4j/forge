import {
	githubSyncResultSchema,
	githubSyncStatusSchema,
	repositoryBranchesSchema,
	repositoryTreeSchema,
	repositoryFileSchema,
	repositoryHistorySchema,
	repositoryCommitResultSchema,
	type GithubSyncStatus,
	type RepositoryBranch,
	type RepositoryTree,
	type RepositoryFile,
	type RepositoryHistory,
} from "@forge/contracts";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { resolveRoute } from "../navigation/routes.ts";
import { CommitView } from "./commit-view.tsx";
import { Editor } from "./editor.tsx";
import { FileIcon } from "./file-icon.tsx";
import { RepositoryFileTree } from "./repository-file-tree.tsx";

const ChangedAt = ({ date }: { date?: string }) =>
	date ? (
		<time dateTime={date}>
			{new Date(date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
		</time>
	) : (
		<span>—</span>
	);

const Readme = ({ content }: { content: string }) => (
	<div className='readme-content'>
		{content.split(/\n\s*\n/u).map((block, index) => {
			if (block.startsWith("# ")) return <h1 key={index}>{block.slice(2)}</h1>;
			if (block.startsWith("## ")) return <h2 key={index}>{block.slice(3)}</h2>;
			if (block.startsWith("### ")) return <h3 key={index}>{block.slice(4)}</h3>;
			if (block.startsWith("```"))
				return (
					<pre key={index}>
						<code>{block.replace(/^```[^\n]*\n/u, "").replace(/\n```$/u, "")}</code>
					</pre>
				);
			return <p key={index}>{block}</p>;
		})}
	</div>
);

interface Draft {
	original?: string;
	content: string;
}

const BranchBrowser = ({
	root,
	codePath,
	repositoryName,
	branch,
	api,
	dirtyChange,
	branchControl,
	search,
	syncVisible,
}: {
	branchControl: ReactNode;
	root: string;
	codePath: string;
	repositoryName: string;
	branch: string;
	api: IWorkspaceApi;
	dirtyChange: (branch: string, dirty: boolean) => void;
	search?: string;
	syncVisible: boolean;
}) => {
	const navigate = useNavigate();
	const [retainedSearch, setRetainedSearch] = useState("");
	const selection = new URLSearchParams(search ?? retainedSearch);
	const path = selection.get("path") ?? "";
	const active = selection.get("file") ?? "";
	const showingHistory = selection.get("view") === "history";
	const commitLink = (sha: string) => {
		const query = new URLSearchParams(selection);
		query.set("branch", branch);
		query.set("view", "commit");
		query.set("sha", sha);
		return `${codePath}?${query}`;
	};
	if (search !== undefined && retainedSearch !== search) setRetainedSearch(search);
	const navigateCode = (directory: string, file = "", history = false) => {
		const query = new URLSearchParams({ branch });
		if (directory) query.set("path", directory);
		if (file) query.set("file", file);
		if (history) query.set("view", "history");
		void navigate(`${codePath}?${query}`);
	};
	const editorId = useId();
	const [tree, setTree] = useState<RepositoryTree>();
	const [baseHead, setBaseHead] = useState("");
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const [readmeResult, setReadmeResult] = useState<{ key: string; file?: RepositoryFile; error?: string }>();
	const [history, setHistory] = useState<RepositoryHistory>();
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [revision, setRevision] = useState(0);
	const [toast, setToast] = useState<{ message: string; error?: boolean }>();
	const [syncStatus, setSyncStatus] = useState<GithubSyncStatus>();
	const [syncing, setSyncing] = useState(false);
	const driftUnavailable = useRef(false);
	const reportError = useCallback(
		(message: string) => {
			setError(message);
			setToast({ message, error: true });
		},
		[setError, setToast],
	);
	useEffect(() => {
		if (!toast) return;
		const timer = setTimeout(() => setToast(undefined), 5_000);
		return () => clearTimeout(timer);
	}, [toast]);
	const readyDrift = syncStatus?.state === "ready" ? syncStatus : undefined;
	const changed = Object.entries(drafts).filter(([, draft]) => draft.original !== draft.content);
	const dirty = changed.length > 0;
	const disabled = busy || loading || syncing;
	const draft = drafts[active];
	const breadcrumbPath = active && !showingHistory ? active.split("/").slice(0, -1).join("/") : path;
	const entries = [...(tree?.entries ?? [])].sort((a, b) =>
		a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
	);
	const readmePath = entries.find(
		(entry) => entry.kind === "file" && /^readme(?:\.(?:md|markdown|txt))?$/iu.test(entry.name),
	)?.path;
	const readmeKey = `${revision}:${readmePath ?? ""}`;
	const readme = readmeResult?.key === readmeKey ? readmeResult.file : undefined;
	const readmeError = readmeResult?.key === readmeKey ? readmeResult.error : undefined;
	const loadTree = useCallback(
		(directory: string) =>
			api.read(
				`${root}/tree?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(directory)}`,
				repositoryTreeSchema,
			),
		[api, root, branch],
	);
	useEffect(() => {
		dirtyChange(branch, dirty);
	}, [dirtyChange, branch, dirty]);
	useEffect(() => {
		if (!syncVisible || syncing) return;
		let cancelled = false;
		let checking = false;
		let unconfigured = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const updateStatus = (status: GithubSyncStatus) => {
			if (cancelled) return;
			setSyncStatus(status);
			if (status.state === "unavailable" && !driftUnavailable.current) {
				setToast((current) => current ?? { message: "GitHub drift unavailable.", error: true });
			}
			driftUnavailable.current = status.state === "unavailable";
		};
		const check = async () => {
			if (cancelled || checking || unconfigured || document.hidden) return;
			clearTimeout(timer);
			checking = true;
			try {
				const status = await api.read(`${root}/github-sync`, githubSyncStatusSchema);
				updateStatus(status);
				unconfigured = status.state === "unconfigured";
			} catch {
				updateStatus({ state: "unavailable" });
			} finally {
				checking = false;
				if (!cancelled && !unconfigured) timer = setTimeout(() => void check(), 30_000);
			}
		};
		const onVisibility = () => void check();
		document.addEventListener("visibilitychange", onVisibility);
		void check();
		return () => {
			cancelled = true;
			clearTimeout(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [api, root, revision, syncing, syncVisible]);
	useEffect(() => {
		let cancelled = false;
		void loadTree(path)
			.then((value) => {
				if (cancelled) return;
				setTree(value);
				setBaseHead((current) => current || value.head);
			})
			.catch(() => {
				if (!cancelled) reportError("Files unavailable. Retry loading files.");
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [loadTree, path, revision, reportError]);
	useEffect(() => {
		let cancelled = false;
		if (readmePath)
			void api
				.read(
					`${root}/file?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(readmePath)}`,
					repositoryFileSchema,
				)
				.then((value) => {
					if (!cancelled) setReadmeResult({ key: readmeKey, file: value });
				})
				.catch(() => {
					if (!cancelled)
						setReadmeResult({
							key: readmeKey,
							error: "README preview unavailable. Open the file to inspect it.",
						});
				});
		return () => {
			cancelled = true;
		};
	}, [api, root, branch, readmePath, readmeKey]);
	const run = async (action: () => Promise<void>) => {
		setBusy(true);
		setError("");
		setToast(undefined);
		try {
			await action();
		} catch (failure) {
			reportError(failure instanceof Error ? failure.message : "Operation failed");
		} finally {
			setBusy(false);
		}
	};
	useEffect(() => {
		if (!active || Object.hasOwn(drafts, active) || showingHistory) return;
		let cancelled = false;
		void api
			.read(
				`${root}/file?branch=${encodeURIComponent(branch)}&path=${encodeURIComponent(active)}`,
				repositoryFileSchema,
			)
			.then((value) => {
				if (!cancelled) {
					setError("");
					setDrafts((current) => ({
						...current,
						[active]: { original: value.content, content: value.content },
					}));
				}
			})
			.catch(() => {
				if (!cancelled) reportError("File unavailable. Select another file or return to files.");
			});
		return () => {
			cancelled = true;
		};
	}, [api, root, branch, active, drafts, showingHistory, revision, reportError]);
	useEffect(() => {
		if (!showingHistory) return;
		let cancelled = false;
		void api
			.read(`${root}/history?branch=${encodeURIComponent(branch)}&offset=0`, repositoryHistorySchema)
			.then((value) => {
				if (!cancelled) {
					setHistory(value);
					setError("");
				}
			})
			.catch(() => {
				if (!cancelled) reportError("Commit history unavailable. Reopen history to retry.");
			});
		return () => {
			cancelled = true;
		};
	}, [api, root, branch, showingHistory, revision, reportError]);
	const open = async (file: string) => {
		navigateCode(file.split("/").slice(0, -1).join("/"), file);
	};
	const browse = (directory: string) => {
		if (path !== directory) {
			setLoading(true);
			setTree(undefined);
		}
		navigateCode(directory);
	};
	const showHistory = async (more = false) => {
		const value = await api.read(
			`${root}/history?branch=${encodeURIComponent(branch)}&offset=${more ? (history?.commits.length ?? 0) : 0}`,
			repositoryHistorySchema,
		);
		if (more && history && value.head !== history.head)
			throw new Error("Branch changed. Reopen commit history to refresh.");
		setHistory(more && history ? { ...value, commits: [...history.commits, ...value.commits] } : value);
	};
	const syncGithub = async () => {
		setSyncing(true);
		setToast(undefined);
		try {
			await api.read(`${root}/github-sync`, githubSyncResultSchema, "POST");
			setToast({ message: "Main synced with GitHub." });
		} catch (failure) {
			setToast({
				message: failure instanceof Error ? failure.message : "Could not sync with GitHub.",
				error: true,
			});
		} finally {
			setDrafts({});
			setBaseHead("");
			setLoading(true);
			setRevision((value) => value + 1);
			setSyncing(false);
		}
	};
	const historyButton = (
		<button
			className='history-button'
			aria-label='Commit history'
			title='Commit history'
			disabled={disabled}
			onClick={() => navigateCode(path, active, true)}
		>
			<svg width='18' height='18' viewBox='0 0 20 20' aria-hidden='true'>
				<path d='M3 8a7 7 0 1 1 0 5M3 3v5h5m2-3v5l3 2' fill='none' stroke='currentColor' strokeWidth='1.6' />
			</svg>
		</button>
	);
	const backToFiles = (
		<button disabled={disabled} onClick={() => navigateCode(path)}>
			Back to files
		</button>
	);
	const dateHeading = (
		<span className='repository-date-heading'>
			<span>Last commit date</span>
			{historyButton}
		</span>
	);
	return (
		<div className='branch-browser' aria-busy={disabled}>
			<div className='repository-toolbar'>
				{branchControl}
				<nav aria-label='File path'>
					<button disabled={disabled} onClick={() => browse("")}>
						{repositoryName}
					</button>
					{breadcrumbPath
						.split("/")
						.filter(Boolean)
						.map((part, index, parts) => (
							<span key={index}>
								{" / "}
								<button disabled={disabled} onClick={() => browse(parts.slice(0, index + 1).join("/"))}>
									{part}
								</button>
							</span>
						))}
					{active && <span> / {active.split("/").at(-1)}</span>}
				</nav>
				{syncVisible && syncStatus?.state !== "unconfigured" && (
					<button
						className='repository-sync-button'
						type='button'
						disabled={disabled || dirty}
						title={dirty ? "Commit or discard main drafts before syncing." : undefined}
						onClick={() => void syncGithub()}
					>
						{syncing ? "Syncing with GitHub…" : "Sync with GitHub"}
						{!!readyDrift?.ahead && (
							<>
								{" "}
								<span aria-label={`${readyDrift.ahead} ahead`}>↑{readyDrift.ahead}</span>
							</>
						)}
						{!!readyDrift?.behind && (
							<>
								{" "}
								<span aria-label={`${readyDrift.behind} behind`}>↓{readyDrift.behind}</span>
							</>
						)}
					</button>
				)}
			</div>
			{toast && (
				<div
					className={`repository-toast${toast.error ? " error" : ""}`}
					role={toast.error ? "alert" : "status"}
				>
					<span>{toast.message}</span>
					<button type='button' aria-label='Dismiss notification' onClick={() => setToast(undefined)}>
						×
					</button>
				</div>
			)}
			{loading && !tree && <p role='status'>Loading files…</p>}
			{!tree && !loading && (
				<button
					onClick={() => {
						setLoading(true);
						setError("");
						setRevision((value) => value + 1);
					}}
				>
					Retry loading files
				</button>
			)}
			<div className={active && !showingHistory ? "repository-layout has-file" : "repository-layout"}>
				{active && !showingHistory && (
					<aside className='repository-sidebar' aria-label='File tree'>
						<h3>Files</h3>
						<RepositoryFileTree
							key={revision}
							initial={path === "" ? tree : undefined}
							load={loadTree}
							open={(file) => run(() => open(file))}
							disabled={disabled}
							active={active}
						/>
					</aside>
				)}
				<div className='repository-main'>
					{!showingHistory && Object.keys(drafts).length > 0 && (
						<>
							<div className='editor-tabs' role='tablist' aria-label='Editor tabs'>
								{Object.entries(drafts).map(([file, value], index) => (
									<button
										key={file}
										id={`${editorId}-tab-${index}`}
										role='tab'
										aria-selected={active === file}
										aria-controls={`${editorId}-panel`}
										disabled={disabled}
										onClick={() => void open(file)}
									>
										<FileIcon name={file} />
										{file}
										{value.original !== value.content ? " *" : ""}
									</button>
								))}
							</div>
						</>
					)}
					{active && !showingHistory ? (
						<div className='editor-pane'>
							<section
								id={`${editorId}-panel`}
								role='tabpanel'
								aria-labelledby={`${editorId}-tab-${Object.keys(drafts).indexOf(active)}`}
							>
								<div className='file-list-header'>
									<span>{active}</span>
									<div className='file-controls'>
										{backToFiles}
										{historyButton}
									</div>
								</div>
								{!draft && !error && <p role='status'>Loading file…</p>}
								{draft && (
									<div className='repository-code'>
										<Editor
											key={`${active}:${syncing}`}
											path={active}
											content={draft.content}
											readOnly={syncing}
											change={(content) =>
												setDrafts((current) => ({
													...current,
													[active]: { ...current[active]!, content },
												}))
											}
										/>
									</div>
								)}
							</section>
						</div>
					) : (
						<>
							{showingHistory && (
								<div className='file-list-header history-list-header'>
									{backToFiles}
									{dateHeading}
								</div>
							)}
							{showingHistory ? (
								<section className='commit-history' aria-label='Commit history'>
									<h2>{branch}</h2>
									{!history && !error && <p role='status'>Loading commits…</p>}
									{history?.commits.map((commit) => (
										<article key={commit.sha}>
											<strong>
												<Link to={commitLink(commit.sha)}>{commit.subject}</Link>
											</strong>
											<p>
												{commit.author} · <ChangedAt date={commit.date} />
											</p>
											<Link to={commitLink(commit.sha)}>
												<code>{commit.sha.slice(0, 7)}</code>
											</Link>
										</article>
									))}
									{history?.commits.length === 0 && <p>No commits yet.</p>}
									{history?.hasMore && (
										<button disabled={disabled} onClick={() => void run(() => showHistory(true))}>
											Load more commits
										</button>
									)}
								</section>
							) : (
								<>
									<table className='repository-files' aria-label='Repository files'>
										<thead>
											<tr>
												<th scope='col'>Name</th>
												<th scope='col' className='file-commit'>
													Last commit message
												</th>
												<th scope='col'>{dateHeading}</th>
											</tr>
										</thead>
										<tbody>
											{path && (
												<tr>
													<td>
														<button
															disabled={disabled}
															onClick={() =>
																browse(path.split("/").slice(0, -1).join("/"))
															}
														>
															<FileIcon name='..' directory />
															<span>..</span>
														</button>
													</td>
													<td className='file-commit' />
													<td />
												</tr>
											)}
											{entries.map((entry) => (
												<tr key={entry.path}>
													<td>
														<button
															aria-label={entry.name}
															disabled={disabled}
															onClick={() =>
																entry.kind === "directory"
																	? browse(entry.path)
																	: void run(() => open(entry.path))
															}
														>
															<FileIcon
																name={entry.name}
																directory={entry.kind === "directory"}
															/>
															<span>{entry.name}</span>
														</button>
													</td>
													<td className='file-commit'>{entry.lastCommit?.subject ?? "—"}</td>
													<td>
														<ChangedAt date={entry.lastCommit?.date} />
													</td>
												</tr>
											))}
										</tbody>
									</table>
									{!entries.length && !loading && (
										<p className='repository-empty'>This directory is empty.</p>
									)}
									{tree?.truncated && (
										<p className='notice'>
											Directory exceeds the 1,000-entry limit. Some files are not shown.
										</p>
									)}
								</>
							)}
						</>
					)}
				</div>
			</div>
			{!active && !showingHistory && (readme || readmeError) && (
				<section className='repository-readme' aria-label='README'>
					<div className='readme-heading'>
						<FileIcon name='README.md' />
						<strong>README</strong>
					</div>
					{readme ? (
						<Readme content={drafts[readme.path]?.content ?? readme.content} />
					) : (
						<p>{readmeError}</p>
					)}
				</section>
			)}
			{dirty && (
				<form
					className='commit-drafts'
					onSubmit={(event) => {
						event.preventDefault();
						void run(async () => {
							const files = changed.map(([file, value]) => ({ path: file, content: value.content }));
							const result = await api.read(`${root}/commit`, repositoryCommitResultSchema, "POST", {
								branch,
								expectedHead: baseHead,
								message,
								files,
							});
							setBaseHead(result.head);
							setDrafts((current) =>
								Object.fromEntries(
									Object.entries(current).map(([file, value]) => {
										const sent = files.find((entry) => entry.path === file);
										return [file, sent ? { ...value, original: sent.content } : value];
									}),
								),
							);
							setMessage("");
							setToast({
								message: `Committed ${files.length} ${files.length === 1 ? "file" : "files"} to ${branch}.`,
							});
							setLoading(true);
							setRevision((value) => value + 1);
						});
					}}
				>
					<p>
						{changed.length} changed {changed.length === 1 ? "file" : "files"} · Drafts stay in this browser
						until committed to <strong>{branch}</strong>.
					</p>
					<label>
						Commit message
						<input
							value={message}
							maxLength={4096}
							onChange={(event) => setMessage(event.target.value)}
							disabled={busy}
							required
						/>
					</label>
					<div className='toolbar'>
						<button className='primary' type='submit' disabled={disabled || !message.trim()}>
							Commit
						</button>
						<button
							type='button'
							disabled={disabled}
							onClick={() => {
								setDrafts({});
								navigateCode(path);
								setBaseHead("");
								setError("");
								setHistory(undefined);
								setLoading(true);
								setTree(undefined);
								setRevision((value) => value + 1);
							}}
						>
							Discard all drafts
						</button>
					</div>
				</form>
			)}
		</div>
	);
};

export const RepositoryBrowser = ({
	projectId,
	repositoryName,
	githubSyncAvailable,
	api,
	dirtyChange,
}: {
	projectId: string;
	repositoryName: string;
	githubSyncAvailable: boolean;
	api: IWorkspaceApi;
	dirtyChange: (branch: string, dirty: boolean) => void;
}) => {
	const location = useLocation();
	const navigate = useNavigate();
	const route = resolveRoute(location.pathname);
	const inCode = route.page === "repo" && route.section === "code";
	const showingCommit = inCode && new URLSearchParams(location.search).get("view") === "commit";
	const [branches, setBranches] = useState<RepositoryBranch[]>([]);
	const [retainedBranch, setRetainedBranch] = useState("");
	const defaultBranch = branches.find((value) => value.name === "main")?.name ?? branches.at(0)?.name ?? "";
	const branch = inCode ? (new URLSearchParams(location.search).get("branch") ?? defaultBranch) : retainedBranch;
	const branchExists = branches.some((value) => value.name === branch);
	const branchLocations = useRef(new Map<string, string>());
	const [visited, setVisited] = useState<string[]>([]);
	const [error, setError] = useState("");
	const [revision, setRevision] = useState(0);
	const root = `projects/${projectId}/repository`;
	if (inCode && branchExists) {
		if (retainedBranch !== branch) setRetainedBranch(branch);
		if (!visited.includes(branch)) setVisited([...visited, branch]);
	}
	useEffect(() => {
		if (!inCode || !branchExists) return;
		branchLocations.current.set(branch, location.pathname + location.search);
	}, [inCode, branchExists, branch, location.pathname, location.search]);
	useEffect(() => {
		let cancelled = false;
		void api
			.read(`${root}/branches`, repositoryBranchesSchema)
			.then((values) => {
				if (cancelled) return;
				setBranches(values);
				setError("");
			})
			.catch(() => {
				if (!cancelled) setError("Branch list unavailable.");
			});
		return () => {
			cancelled = true;
		};
	}, [api, root, revision]);
	return (
		<div className='repository-browser'>
			{showingCommit && <CommitView root={root} api={api} />}
			{!showingCommit && branches.length > 0 && !branchExists && (
				<p role='alert'>
					Branch unavailable.{" "}
					<button onClick={() => void navigate(`/repos/${projectId}/code`)}>Open default branch</button>
				</p>
			)}
			{error && (
				<p role='alert'>
					{error} <button onClick={() => setRevision((value) => value + 1)}>Retry branches</button>
				</p>
			)}
			{!showingCommit && !branches.length && !error && <p>No branches yet.</p>}
			{visited.map((value) => (
				<div key={value} hidden={branch !== value || showingCommit}>
					<BranchBrowser
						root={root}
						codePath={`/repos/${projectId}/code`}
						repositoryName={repositoryName}
						branch={value}
						search={inCode && branch === value && !showingCommit ? location.search : undefined}
						syncVisible={
							githubSyncAvailable && inCode && branch === "main" && value === "main" && !showingCommit
						}
						api={api}
						dirtyChange={dirtyChange}
						branchControl={
							<label className='branch-picker'>
								<span aria-hidden='true'>⑂</span>
								<select
									aria-label='Branch'
									value={branch}
									disabled={!branches.length}
									onChange={(event) => {
										const value = event.target.value;
										void navigate(
											branchLocations.current.get(value)
												?? `/repos/${projectId}/code?${new URLSearchParams({ branch: value })}`,
										);
									}}
								>
									{branches.map((value) => (
										<option key={value.name} value={value.name}>
											{value.name}
										</option>
									))}
								</select>
							</label>
						}
					/>
				</div>
			))}
		</div>
	);
};
