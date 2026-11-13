import { projectsSchema, type Project } from "@forge/contracts";
import { useEffect, useId, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";

export const RepositorySelection = ({
	api,
	value,
	change,
	disabled = false,
}: {
	api: IWorkspaceApi;
	value: string[];
	change: (ids: string[]) => void;
	disabled?: boolean;
}) => {
	const [repositories, setRepositories] = useState<Project[]>();
	const [error, setError] = useState("");
	const [revision, retry] = useState(0);
	const pickerId = useId();
	useEffect(() => {
		let active = true;
		void api.read("projects", projectsSchema).then(
			(rows) => {
				if (active) {
					setRepositories(rows);
					setError("");
				}
			},
			() => {
				if (active) setError("Repositories unavailable.");
			},
		);
		return () => {
			active = false;
		};
	}, [api, revision]);
	return (
		<fieldset disabled={disabled} className='ticket-repositories'>
			<legend>Repositories</legend>
			<button
				type='button'
				className='ticket-repositories-trigger'
				aria-label='Repositories'
				popoverTarget={pickerId}
			>
				<span className='ticket-repository-values'>
					{value.length ? (
						value.map((id) => (
							<span key={id}>{repositories?.find((repo) => repo.id === id)?.name ?? id}</span>
						))
					) : (
						<span className='ticket-repository-placeholder'>Select repositories</span>
					)}
				</span>
				<span className='ticket-chevron' aria-hidden='true' />
			</button>
			{error && (
				<p role='alert'>
					{error}{" "}
					<button type='button' onClick={() => retry(revision + 1)}>
						Retry repositories
					</button>
				</p>
			)}
			{!repositories && !error && <p role='status'>Loading repositories…</p>}
			<div
				id={pickerId}
				popover='auto'
				className='ticket-picker ticket-repository-picker'
				role='group'
				aria-label='Select repositories'
			>
				{repositories?.map((repo) => (
					<label key={repo.id} className='ticket-repository-option'>
						<input
							type='checkbox'
							checked={value.includes(repo.id)}
							onChange={(event) =>
								change(
									event.target.checked ? [...value, repo.id] : value.filter((id) => id !== repo.id),
								)
							}
						/>
						<span>
							{repo.name}
							{repo.status !== "ready" && <small> · {repo.status}</small>}
						</span>
					</label>
				))}
				{repositories?.length === 0 && <p>No repositories available.</p>}
				{value.length > 0 && (
					<button type='button' className='ticket-picker-clear' onClick={() => change([])}>
						Clear repositories
					</button>
				)}
			</div>
		</fieldset>
	);
};
