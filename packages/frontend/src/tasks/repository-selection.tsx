import { projectsSchema, type Project } from "@forge/contracts";
import { useEffect, useState } from "react";

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
	const reorder = (index: number, offset: number) => {
		const ids = [...value];
		[ids[index], ids[index + offset]] = [ids[index + offset]!, ids[index]!];
		change(ids);
	};
	return (
		<fieldset disabled={disabled} className='ticket-repositories'>
			<legend>Repositories</legend>
			<p>The first selection is the execution repository. Additional selections are references.</p>
			{error && (
				<p role='alert'>
					{error}{" "}
					<button type='button' onClick={() => retry(revision + 1)}>
						Retry repositories
					</button>
				</p>
			)}
			{!repositories && !error && <p role='status'>Loading repositories…</p>}
			<ol>
				{value.map((id, index) => (
					<li key={id}>
						<span>
							{repositories?.find((repo) => repo.id === id)?.name ?? id}
							{index === 0 && " · Execution repository"}
						</span>
						<button
							type='button'
							aria-label={`Move repository ${index + 1} up`}
							disabled={index === 0}
							onClick={() => reorder(index, -1)}
						>
							↑
						</button>
						<button
							type='button'
							aria-label={`Move repository ${index + 1} down`}
							disabled={index === value.length - 1}
							onClick={() => reorder(index, 1)}
						>
							↓
						</button>
						<button
							type='button'
							aria-label={`Remove repository ${index + 1}`}
							onClick={() => change(value.filter((item) => item !== id))}
						>
							Remove
						</button>
					</li>
				))}
			</ol>
			<label>
				Add repository
				<select
					value=''
					onChange={(event) => {
						if (event.target.value) change([...value, event.target.value]);
					}}
				>
					<option value=''>Select a repository</option>
					{repositories
						?.filter((repo) => !value.includes(repo.id))
						.map((repo) => (
							<option key={repo.id} value={repo.id}>
								{repo.name}
								{repo.status !== "ready" ? ` (${repo.status})` : ""}
							</option>
						))}
				</select>
			</label>
			{value.length === 0 && (
				<p>
					No repositories selected. Select a ready execution repository before moving to Ready for
					development.
				</p>
			)}
		</fieldset>
	);
};
