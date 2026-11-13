import type { EpicSummary } from "@forge/contracts/tickets";

import { EpicIcon } from "./epic-icon.tsx";
import type { TaskViewProps } from "./task-board.tsx";
import { EpicProgress, TicketTable } from "./ticket-table.tsx";
export const TaskBacklog = ({
	tickets,
	busy,
	loading,
	error,
	notice,
	open,
	create,
	refresh,
	epics,
	collapsed,
	toggleEpic,
	openEpic,
	createEpic,
	createInEpic,
}: TaskViewProps & {
	epics: EpicSummary[];
	collapsed: string[];
	toggleEpic: (id: string) => void;
	openEpic: (id: string) => void;
	createEpic: () => void;
	createInEpic: (id: string) => void;
}) => {
	const unfinished = tickets.filter((ticket) => !ticket.archivedAt && ticket.status !== "done");
	return (
		<div className='task-backlog'>
			<div className='task-board-heading'>
				<h2>Backlog</h2>
				<div className='task-board-actions'>
					<button disabled={busy || loading} onClick={createEpic}>
						Create epic
					</button>
					<button disabled={busy || loading} onClick={refresh}>
						Refresh
					</button>
					<button className='primary' disabled={busy || loading} onClick={create}>
						Create ticket
					</button>
				</div>
			</div>
			{error && (
				<p role='alert' className='error'>
					{error} Use Refresh to retry.
				</p>
			)}
			<p role='status'>
				{loading ? "Loading tickets…" : `${unfinished.length} unfinished tickets`}
				{notice && ` · ${notice}`}
			</p>
			<div
				className='backlog-scroll'
				role='region'
				aria-label='Unfinished tickets'
				tabIndex={0}
				aria-busy={busy || loading}
			>
				{[undefined, ...epics].map((epic) => {
					const rows = unfinished.filter((ticket) => (ticket.epicId ?? undefined) === epic?.id);
					const expanded = !epic || !collapsed.includes(epic.id);
					const titleId = `backlog-title-${epic?.id ?? "no-epic"}`;
					const childrenId = `children-${epic?.id ?? "no-epic"}`;
					return (
						<section key={titleId} className='backlog-section'>
							<div className='backlog-section-header'>
								{epic && (
									<button
										className='backlog-epic-toggle'
										aria-expanded={expanded}
										aria-controls={childrenId}
										aria-label={`${expanded ? "Collapse" : "Expand"} ${epic.id}`}
										onClick={() => toggleEpic(epic.id)}
									>
										<span className='ticket-chevron' aria-hidden='true' />
									</button>
								)}
								<h3 id={titleId}>
									{epic ? (
										<button className='backlog-epic-link' onClick={() => openEpic(epic.id)}>
											<EpicIcon />
											<span>
												<span className='backlog-epic-key'>{epic.id}</span>
												{" · "}
												{epic.title}
											</span>
										</button>
									) : (
										"No epic"
									)}
								</h3>
								{epic && (
									<>
										<EpicProgress done={epic.done} total={epic.total} />
										<button
											className='backlog-epic-create'
											disabled={busy}
											onClick={() => createInEpic(epic.id)}
										>
											<span aria-hidden='true'>+</span> Create ticket
										</button>
									</>
								)}
							</div>
							<TicketTable
								id={childrenId}
								labelId={titleId}
								hidden={!expanded}
								tickets={rows}
								busy={busy}
								open={open}
								emptyMessage={epic ? "No unfinished tickets in this epic." : undefined}
							/>
						</section>
					);
				})}
				{!loading && !error && !unfinished.length && (
					<p className='kanban-empty'>No unfinished tickets. Create a ticket to get started.</p>
				)}
			</div>
		</div>
	);
};
