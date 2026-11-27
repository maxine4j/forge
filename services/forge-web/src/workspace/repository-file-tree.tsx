import type { WorkspaceTree, RepositoryTree } from "@forge/contracts";
import { useEffect, useState } from "react";

import { useErrorState } from "../toasts/toasts.tsx";
import { FileIcon } from "./file-icon.tsx";

type Tree = WorkspaceTree | RepositoryTree;
interface TreeActions {
	load: (path: string) => Promise<Tree>;
	open: (path: string) => Promise<void>;
	disabled: boolean;
	active: string;
}

const DirectoryEntries = ({ tree, ...actions }: TreeActions & { tree: Tree }) => {
	const entries = [...tree.entries].sort((a, b) =>
		a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1,
	);
	return (
		<ul className='file-tree-list'>
			{entries.map((entry) => (
				<TreeEntry key={entry.path} entry={entry} {...actions} />
			))}
			{tree.truncated && (
				<li>
					<p>File tree truncated at 1,000 entries.</p>
				</li>
			)}
		</ul>
	);
};

const TreeEntry = ({ entry, ...actions }: TreeActions & { entry: Tree["entries"][number] }) => {
	const [expanded, setExpanded] = useState(false);
	const [tree, setTree] = useState<Tree>();
	const [loading, setLoading] = useState(false);
	const [, setError] = useErrorState();
	const directory = entry.kind === "directory";
	const select = async () => {
		setError("");
		if (directory && expanded) {
			setExpanded(false);
			return;
		}
		setLoading(true);
		try {
			if (directory) {
				setTree(await actions.load(entry.path));
				setExpanded(true);
			} else await actions.open(entry.path);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : "File unavailable. Retry.");
		} finally {
			setLoading(false);
		}
	};
	return (
		<li>
			<button
				className='tree-entry'
				aria-label={`Open ${entry.name}`}
				aria-expanded={directory ? expanded : undefined}
				aria-current={actions.active === entry.path ? "page" : undefined}
				disabled={actions.disabled || loading}
				onClick={() => void select()}
			>
				<span aria-hidden='true'>{directory ? (expanded ? "⌄" : "›") : ""}</span>
				<FileIcon name={entry.name} directory={directory} />
				<span>{entry.name}</span>
			</button>
			{loading && <p role='status'>Loading…</p>}

			{expanded && tree && <DirectoryEntries tree={tree} {...actions} />}
		</li>
	);
};

export const RepositoryFileTree = ({ initial, load, ...actions }: TreeActions & { initial?: Tree }) => {
	const [tree, setTree] = useState<Tree>();
	const [, setError] = useErrorState();
	useEffect(() => {
		if (initial) return;
		let cancelled = false;
		void load("")
			.then((value) => {
				if (!cancelled) setTree(value);
			})
			.catch(() => {
				if (!cancelled) setError("File tree unavailable. Return to files to retry.");
			});
		return () => {
			cancelled = true;
		};
	}, [initial, load, setError]);
	return <>{(initial ?? tree) && <DirectoryEntries tree={(initial ?? tree)!} load={load} {...actions} />}</>;
};
