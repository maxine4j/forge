import { projectsSchema, type Project } from "@forge/contracts";
import { useEffect, useState } from "react";

import type { IWorkspaceApi } from "../api/workspace-api.ts";
import { DropdownSurface } from "../dropdown.tsx";
import { useErrorState } from "../toasts/toasts.tsx";

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
	const [error, setError] = useErrorState();
	const [revision, retry] = useState(0);
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
	}, [api, revision, setError]);
	return (
		<fieldset disabled={disabled} className='ticket-repositories'>
			<legend>Repositories</legend>
			{error && (
				<p>
					<button type='button' onClick={() => retry(revision + 1)}>
						Retry repositories
					</button>
				</p>
			)}
			{!repositories && !error && <p role='status'>Loading repositories…</p>}
			<DropdownSurface
				label='Repositories'
				popupLabel='Select repositories'
				dismissWhenDisabled={false}
				disabled={disabled}
				className='ticket-repositories-trigger'
				trigger={
					<span className='ticket-repository-values'>
						{value.length ? (
							value.map((id) => (
								<span key={id}>{repositories?.find((repo) => repo.id === id)?.name ?? id}</span>
							))
						) : (
							<span className='ticket-repository-placeholder'>Select repositories</span>
						)}
					</span>
				}
			>
				{() => (
					<>
						{repositories?.map((repo) => (
							<label key={repo.id} className='dropdown-option ticket-repository-option'>
								<input
									type='checkbox'
									disabled={disabled}
									checked={value.includes(repo.id)}
									onChange={(event) =>
										change(
											event.target.checked
												? [...value, repo.id]
												: value.filter((id) => id !== repo.id),
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
					</>
				)}
			</DropdownSurface>
		</fieldset>
	);
};
