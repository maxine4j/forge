import type { CommitDetail } from "@forge/contracts";
import { useState } from "react";

import { FileIcon } from "./file-icon.tsx";

type ChangedFile = CommitDetail["files"][number];
type Entry = { name: string; children: Entries } | { name: string; file: ChangedFile; index: number };
type Entries = Map<string, Entry>;

const fileDiffPath =
	"M1 1.75C1 .784 1.784 0 2.75 0h7.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16H2.75A1.75 1.75 0 0 1 1 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073ZM8 3.25a.75.75 0 0 1 .75.75v1.5h1.5a.75.75 0 0 1 0 1.5h-1.5v1.5a.75.75 0 0 1-1.5 0V7h-1.5a.75.75 0 0 1 0-1.5h1.5V4A.75.75 0 0 1 8 3.25Zm-3 8a.75.75 0 0 1 .75-.75h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1-.75-.75Z";
const statusIcons = {
	M: { label: "Modified", icon: "file-diff", path: fileDiffPath },
	T: { label: "Type changed", icon: "file-diff", path: fileDiffPath },
	A: {
		label: "Added",
		icon: "file-added",
		path: "M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073Zm4.48 3.758a.75.75 0 0 1 .755.745l.01 1.497h1.497a.75.75 0 0 1 0 1.5H9v1.507a.75.75 0 0 1-1.5 0V9.005l-1.502.01a.75.75 0 0 1-.01-1.5l1.507-.01-.01-1.492a.75.75 0 0 1 .745-.755Z",
	},
	D: {
		label: "Deleted",
		icon: "file-removed",
		path: "M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073Zm4.5 6h2.242a.75.75 0 0 1 0 1.5h-2.24l-2.254.015a.75.75 0 0 1-.01-1.5Z",
	},
	R: {
		label: "Renamed",
		icon: "file-moved",
		path: "M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-3.5a.75.75 0 0 1 0-1.5h3.5a.25.25 0 0 0 .25-.25V4.664a.25.25 0 0 0-.073-.177l-2.914-2.914a.25.25 0 0 0-.177-.073H3.75a.25.25 0 0 0-.25.25v6.5a.75.75 0 0 1-1.5 0v-6.5ZM5.427 15.573l3.146-3.146a.25.25 0 0 0 0-.354L5.427 8.927A.25.25 0 0 0 5 9.104V11.5H.75a.75.75 0 0 0 0 1.5H5v2.396c0 .223.27.335.427.177Z",
	},
};

const buildTree = (files: ChangedFile[], filter: string): Entries => {
	const root: Entries = new Map();
	files.forEach((file, index) => {
		if (!file.path.toLowerCase().includes(filter)) return;
		const segments = file.path.split("/");
		const name = segments.pop()!;
		let children = root;
		for (const segment of segments) {
			const key = `${segment}/`;
			const entry = children.get(key);
			if (entry && "children" in entry) {
				children = entry.children;
			} else {
				const folder = new Map<string, Entry>();
				children.set(key, { name: segment, children: folder });
				children = folder;
			}
		}
		children.set(name, { name, file, index });
	});
	return root;
};

const FileRow = ({ name, file, index, stats }: { name: string; file: ChangedFile; index: number; stats: string }) => {
	const { label, icon, path } = statusIcons[file.status];
	const panelId = `commit-file-${index}`;
	return (
		<a
			className={`changed-file status-${file.status}`}
			href={`#${panelId}`}
			onClick={() => document.getElementById(panelId)?.setAttribute("open", "")}
		>
			<svg
				className={`octicon-${icon}`}
				aria-hidden='true'
				viewBox='0 0 16 16'
				width='16'
				height='16'
				fill='currentColor'
			>
				<path d={path} />
			</svg>
			<span className='changed-file-name' title={file.path}>
				{name}
			</span>
			<span className='changed-file-status' title={label} aria-hidden='true'>
				{file.status}
			</span>
			<span className='visually-hidden'>{label}</span>
			<small>{stats}</small>
		</a>
	);
};

interface TreeProps {
	entries: Entries;
	filtering: boolean;
	displayedStats: (file: ChangedFile) => string;
}

const Folder = ({ name, entries, filtering, displayedStats }: TreeProps & { name: string }) => {
	const [collapsed, setCollapsed] = useState(false);
	const expanded = filtering || !collapsed;
	return (
		<>
			<button
				className='changed-files-folder'
				type='button'
				aria-expanded={expanded}
				disabled={filtering}
				onClick={() => setCollapsed(!collapsed)}
			>
				<span aria-hidden='true'>{expanded ? "⌄" : "›"}</span>
				<FileIcon name={name} directory />
				<span>{name}</span>
			</button>
			{expanded && <Tree entries={entries} filtering={filtering} displayedStats={displayedStats} />}
		</>
	);
};

const Tree = ({ entries, filtering, displayedStats }: TreeProps) => (
	<ul className='file-tree-list changed-files-list'>
		{[...entries].map(([key, entry]) => (
			<li key={key}>
				{"children" in entry ? (
					<Folder
						name={entry.name}
						entries={entry.children}
						filtering={filtering}
						displayedStats={displayedStats}
					/>
				) : (
					<FileRow {...entry} stats={displayedStats(entry.file)} />
				)}
			</li>
		))}
	</ul>
);

export const ChangedFilesTree = ({
	files,
	filter,
	displayedStats,
}: {
	files: ChangedFile[];
	filter: string;
	displayedStats: TreeProps["displayedStats"];
}) => (
	<nav aria-label='Changed files'>
		<Tree
			entries={buildTree(files, filter.toLowerCase())}
			filtering={Boolean(filter)}
			displayedStats={displayedStats}
		/>
	</nav>
);
