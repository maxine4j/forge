import { commitDetailSchema, commitPatchSchema, type CommitDetail, type CommitPatch } from "@forge/contracts";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { Dropdown, DropdownOption } from "../dropdown.tsx";
import { useToast } from "../toasts/toasts.tsx";
import { ChangedFilesTree } from "./changed-files-tree.tsx";

type Line = CommitPatch["hunks"][number]["lines"][number];
export function splitLines(lines: Line[]): [Line | undefined, Line | undefined][] {
	const rows: [Line | undefined, Line | undefined][] = [];
	for (let i = 0; i < lines.length;) {
		const line = lines[i]!;
		if (line.kind === "deletion" || line.kind === "addition") {
			const removed: Line[] = [],
				added: Line[] = [],
				oldMarkers: Line[] = [],
				newMarkers: Line[] = [];
			let side: "deletion" | "addition" = line.kind;
			while (i < lines.length) {
				const changed = lines[i]!;
				if (changed.kind === "deletion") {
					removed.push(changed);
					side = "deletion";
				} else if (changed.kind === "addition") {
					added.push(changed);
					side = "addition";
				} else if (changed.kind === "marker") (side === "deletion" ? oldMarkers : newMarkers).push(changed);
				else break;
				i++;
			}
			for (let j = 0; j < Math.max(removed.length, added.length); j++) rows.push([removed[j], added[j]]);
			for (let j = 0; j < Math.max(oldMarkers.length, newMarkers.length); j++)
				rows.push([oldMarkers[j], newMarkers[j]]);
		} else {
			rows.push([line, line]);
			i++;
		}
	}
	return rows;
}

const Patch = ({ patch, split }: { patch: CommitPatch; split: boolean }) => (
	<>
		<p className='patch-stats'>
			+{patch.additions} −{patch.deletions} displayed lines
		</p>
		{patch.oldMode !== patch.newMode && (
			<p>
				Mode: {patch.oldMode} → {patch.newMode}
			</p>
		)}
		{patch.truncated && (
			<p role='status'>Patch incomplete: output exceeded a limit or could not be decoded as UTF-8.</p>
		)}
		{patch.binary ? (
			<p>Binary or non-UTF-8 content — no text preview.</p>
		) : patch.submodule ? (
			<p>Submodule change — no text preview.</p>
		) : (
			<>
				{!patch.hunks.length && !patch.truncated && (
					<p>No textual changes (mode, rename, or hidden whitespace only).</p>
				)}
				<div className='commit-patch-scroll'>
					<table className={`commit-patch ${split ? "split" : "unified"}`}>
						<tbody>
							{patch.hunks.map((hunk, index) => (
								<FragmentRows key={index} header={hunk.header} lines={hunk.lines} split={split} />
							))}
						</tbody>
					</table>
				</div>
			</>
		)}
	</>
);
const FragmentRows = ({ header, lines, split }: { header: string; lines: Line[]; split: boolean }) => (
	<>
		<tr className='hunk-header'>
			<td colSpan={4}>{header}</td>
		</tr>
		{split
			? splitLines(lines).map(([left, right], i) => (
					<tr key={i}>
						<td className='line-number'>{left?.old}</td>
						<td className={left?.kind ?? "blank"}>
							<pre>{left?.text ?? " "}</pre>
						</td>
						<td className='line-number'>{right?.new}</td>
						<td className={right?.kind ?? "blank"}>
							<pre>{right?.text ?? " "}</pre>
						</td>
					</tr>
				))
			: lines.map((line, i) => (
					<tr key={i} className={line.kind}>
						<td className='line-number'>{line.old}</td>
						<td className='line-number'>{line.new}</td>
						<td>
							<pre>
								{line.kind === "addition" ? "+" : line.kind === "deletion" ? "−" : " "}
								{line.text}
							</pre>
						</td>
					</tr>
				))}
	</>
);

export const CommitView = ({ root, api }: { root: string; api: IWorkspaceApi }) => {
	const location = useLocation(),
		navigate = useNavigate();
	const query = new URLSearchParams(location.search);
	const sha = query.get("sha") ?? "";
	const ignore = query.get("ignoreWhitespace") === "true",
		split = query.get("diff") === "split";
	const [revision, setRevision] = useState(0);
	const readKey = `${root}:${sha}:${revision}`;
	const [result, setResult] = useState<{ key: string; detail?: CommitDetail; error?: string }>();
	const detail = result?.key === readKey ? result.detail : undefined;
	const { notify } = useToast();
	const error = result?.key === readKey ? result.error : undefined;
	const [filter, setFilter] = useState("");
	const patchKey = `${readKey}:${ignore}`;
	const [patchResult, setPatchResult] = useState<{ key: string; values: Record<string, CommitPatch | "error"> }>();
	const patches = patchResult?.key === patchKey ? patchResult.values : {};
	const displayedStats = (file: CommitDetail["files"][number]) => {
		const patch = patches[file.path];
		if (patch && patch !== "error") return `+${patch.additions} −${patch.deletions}`;
		return ignore ? "…" : `+${file.additions} −${file.deletions}`;
	};
	const loaded = Object.values(patches).filter((patch): patch is CommitPatch => patch !== "error");
	const container = useRef<HTMLDivElement>(null);
	const activeRequests = useRef(0);
	const pumpCurrent = useRef<() => void>(() => {});
	const change = (key: string, value: string) => {
		query.set(key, value);
		void navigate(`${location.pathname}?${query}`);
	};
	const link = (parent?: string) => {
		const next = new URLSearchParams(location.search);
		if (parent) next.set("sha", parent);
		else {
			next.set("view", "history");
			next.delete("sha");
		}
		return `${location.pathname}?${next}`;
	};
	useEffect(() => {
		let stale = false;
		void api
			.read(`${root}/commits/${encodeURIComponent(sha)}`, commitDetailSchema)
			.then((value) => {
				if (!stale) setResult({ key: readKey, detail: value });
			})
			.catch(() => {
				if (!stale) {
					setResult({ key: readKey, error: "Commit unavailable. Retry loading the commit." });
					notify("Commit unavailable. Retry loading the commit.");
				}
			});
		return () => {
			stale = true;
		};
	}, [api, root, sha, readKey, notify]);
	useEffect(() => {
		if (!detail || detail.sha !== sha) return;
		let stale = false;
		const queued = new Set<string>(),
			queue: string[] = [];
		const pump = () => {
			while (!stale && activeRequests.current < 4 && queue.length) {
				const path = queue.shift()!;
				activeRequests.current++;
				void api
					.read(
						`${root}/commits/${sha}/diff?${new URLSearchParams({ path, ignoreWhitespace: String(ignore) })}`,
						commitPatchSchema,
					)
					.then((value) => {
						if (!stale)
							setPatchResult((current) => ({
								key: patchKey,
								values: { ...(current?.key === patchKey ? current.values : {}), [path]: value },
							}));
					})
					.catch(() => {
						if (!stale) notify("Diff unavailable.");
						if (!stale)
							setPatchResult((current) => ({
								key: patchKey,
								values: { ...(current?.key === patchKey ? current.values : {}), [path]: "error" },
							}));
					})
					.finally(() => {
						activeRequests.current--;
						pumpCurrent.current();
					});
			}
		};
		pumpCurrent.current = pump;
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries)
					if (entry.isIntersecting) {
						const path = (entry.target as HTMLElement).dataset["path"]!;
						if (!queued.has(path)) {
							queued.add(path);
							queue.push(path);
						}
					}
				pump();
			},
			{ rootMargin: "500px" },
		);
		container.current?.querySelectorAll("[data-path]").forEach((element) => observer.observe(element));
		return () => {
			stale = true;
			observer.disconnect();
		};
	}, [api, root, sha, detail, ignore, patchKey, notify]);
	return (
		<section className='commit-view' aria-label='Commit details'>
			<Link to={link()}>Back to history</Link>
			{error && (
				<p>
					<button onClick={() => setRevision((n) => n + 1)}>Retry commit</button>
				</p>
			)}
			{!detail && !error && <p role='status'>Loading commit…</p>}
			{detail && (
				<>
					<header className='commit-heading'>
						<h2>{detail.subject}</h2>
						<pre>{detail.message.split("\n").slice(1).join("\n").trim()}</pre>
						<p>
							{detail.author} ·{" "}
							<time dateTime={detail.date}>{new Date(detail.date).toLocaleString()}</time>
						</p>
						<p className='commit-sha'>
							<code>{detail.sha}</code>{" "}
							<button
								onClick={() =>
									void navigator.clipboard
										.writeText(detail.sha)
										.catch(() => notify("Could not copy SHA. Select and copy the SHA above."))
								}
							>
								Copy SHA
							</button>
						</p>
						<p>
							Parents:{" "}
							{detail.parents.length
								? detail.parents.map((parent) => (
										<Link key={parent} to={link(parent)}>
											{parent.slice(0, 7)}{" "}
										</Link>
									))
								: "none"}
						</p>
						<p>
							Comparing against{" "}
							{detail.base ? (
								<>
									first parent <Link to={link(detail.base)}>{detail.base.slice(0, 7)}</Link>
								</>
							) : (
								"empty tree (root commit)"
							)}
							.
						</p>
					</header>
					<div className='commit-controls'>
						<strong>
							{detail.files.length} files · +{detail.additions} −{detail.deletions}
							{detail.truncated ? " (incomplete totals)" : ""}
						</strong>
						<label>
							Diff view{" "}
							<Dropdown
								aria-label='Diff view'
								value={split ? "split" : "unified"}
								onChange={(value) => change("diff", value)}
							>
								<DropdownOption value='unified'>Unified</DropdownOption>
								<DropdownOption value='split'>Split</DropdownOption>
							</Dropdown>
						</label>
						<label>
							<input
								type='checkbox'
								checked={ignore}
								onChange={(e) => change("ignoreWhitespace", String(e.target.checked))}
							/>{" "}
							Hide whitespace
						</label>
					</div>
					{ignore && (
						<p>
							Commit totals above include whitespace. Loaded patches ({loaded.length}/
							{detail.files.length}): +{loaded.reduce((n, patch) => n + patch.additions, 0)} −
							{loaded.reduce((n, patch) => n + patch.deletions, 0)} filtered lines.
						</p>
					)}
					{detail.truncated && (
						<p role='status'>
							File listing or totals incomplete: the 1,000-file or command output limit was reached.
						</p>
					)}
					{!detail.files.length && !detail.truncated && <p>No files changed.</p>}
					<div className='commit-layout' ref={container}>
						<aside className='commit-sidebar'>
							<details open>
								<summary>Changed files</summary>
								<input
									aria-label='Filter changed files'
									placeholder='Filter files…'
									value={filter}
									onChange={(e) => setFilter(e.target.value)}
								/>
								<ChangedFilesTree
									key={sha}
									files={detail.files}
									filter={filter}
									displayedStats={displayedStats}
								/>
							</details>
						</aside>
						<div className='commit-panels'>
							{detail.files.map((file, index) => (
								<details
									open
									className='commit-file'
									data-path={file.path}
									id={`commit-file-${index}`}
									key={file.path}
								>
									<summary>
										{file.path} {file.oldPath && <small>renamed from {file.oldPath}</small>}{" "}
										<small>
											{file.status} · {displayedStats(file)}
										</small>
									</summary>
									{patches[file.path] === "error" ? (
										<p>
											<button onClick={() => setRevision((n) => n + 1)}>Retry diffs</button>
										</p>
									) : patches[file.path] ? (
										<Patch patch={patches[file.path] as CommitPatch} split={split} />
									) : (
										<p role='status'>Loading diff…</p>
									)}
								</details>
							))}
						</div>
					</div>
				</>
			)}
		</section>
	);
};
