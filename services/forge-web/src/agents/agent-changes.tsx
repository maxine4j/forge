import { workspaceChangeSummarySchema, type WorkspaceChangeSummary } from "@forge/contracts";
import { useEffect, useId, useRef, useState } from "react";

import { ResourcePoller } from "../api/resource-poller.ts";
import type { IWorkspaceApi } from "../api/workspace-api.ts";

const number = new Intl.NumberFormat("en-AU");

export const AgentChanges = ({ api, workspaceId }: { api: IWorkspaceApi; workspaceId: string }) => {
	const id = useId();
	const button = useRef<HTMLButtonElement>(null);
	const [summary, setSummary] = useState<WorkspaceChangeSummary>();
	const [disclosure, setDisclosure] = useState<"closed" | "hover" | "pinned">("closed");
	useEffect(() => {
		const poller = new ResourcePoller(
			(signal) =>
				api.read(
					`workspaces/${workspaceId}/change-summary`,
					workspaceChangeSummarySchema,
					"GET",
					undefined,
					signal,
				),
			setSummary,
			() => setSummary(undefined),
		);
		poller.refresh();
		return () => poller.stop();
	}, [api, workspaceId]);
	if (!summary?.fileCount) return null;
	const open = disclosure !== "closed";
	return (
		<div
			className='agent-changes'
			onPointerEnter={(event) => {
				if (event.pointerType === "mouse" && disclosure === "closed") setDisclosure("hover");
			}}
			onPointerLeave={() => {
				if (disclosure === "hover") setDisclosure("closed");
			}}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) setDisclosure("closed");
			}}
			onKeyDown={(event) => {
				if (event.key !== "Escape" || !open) return;
				event.preventDefault();
				event.stopPropagation();
				setDisclosure("closed");
				button.current?.focus();
			}}
		>
			<button
				ref={button}
				type='button'
				className='agent-changes-pill'
				aria-expanded={open}
				aria-controls={id}
				onClick={() => setDisclosure((value) => (value === "pinned" ? "closed" : "pinned"))}
			>
				{number.format(summary.fileCount)} {summary.fileCount === 1 ? "file" : "files"} changed
				<span className='agent-changes-added'>+{number.format(summary.additions)}</span>
				<span className='agent-changes-deleted'>−{number.format(summary.deletions)}</span>
				{summary.truncated && <span title='Change summary is partial'>(partial)</span>}
			</button>
			<ul id={id} className='agent-changes-list' aria-label='Changed files' hidden={!open} tabIndex={0}>
				{summary.files.map((path) => (
					<li key={path} title={path}>
						{path}
					</li>
				))}
			</ul>
		</div>
	);
};
