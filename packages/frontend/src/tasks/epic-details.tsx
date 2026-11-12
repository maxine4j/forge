import { editEpicSchema, type EditEpic, type EpicSummary, type Ticket } from "@forge/contracts/tickets";
import { useEffect, useRef, useState } from "react";

import { ticketLabels } from "./ticket-labels.ts";

export const EpicSelection = ({
	epics,
	value,
	change,
	disabled,
}: {
	epics: EpicSummary[];
	value: string | null;
	change: (value: string | null) => void;
	disabled: boolean;
}) => (
	<label>
		Epic
		<select
			aria-label='Epic'
			value={value ?? ""}
			disabled={disabled}
			onChange={(event) => change(event.target.value || null)}
		>
			<option value=''>No epic</option>
			{value && !epics.some((epic) => epic.id === value) && <option value={value}>{value}</option>}
			{epics.map((epic) => (
				<option key={epic.id} value={epic.id}>
					{epic.id} · {epic.title}
				</option>
			))}
		</select>
	</label>
);

export const EpicDetails = ({
	epic,
	tickets,
	busy,
	error,
	close,
	refresh,
	save,
	create,
	open,
}: {
	epic?: EpicSummary;
	tickets: Ticket[];
	busy: boolean;
	error: string;
	close: () => void;
	refresh: () => void;
	save: (input: EditEpic) => Promise<void>;
	create: () => void;
	open: (ticket: Ticket) => void;
}) => {
	const dialog = useRef<HTMLDialogElement>(null);
	const [title, setTitle] = useState(epic?.title ?? "");
	const [description, setDescription] = useState(epic?.description ?? "");
	const [failure, setFailure] = useState("");
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	return (
		<dialog
			ref={dialog}
			className='ticket-dialog'
			aria-labelledby='epic-dialog-title'
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) close();
			}}
		>
			<div className='ticket-dialog-heading'>
				<h2 id='epic-dialog-title'>{epic ? epic.id : "Create epic"}</h2>
				<button disabled={busy} onClick={close} aria-label='Close epic'>
					✕
				</button>
			</div>
			{epic && (
				<>
					<p role='status'>
						{epic.done}/{epic.total} Done{epic.complete ? " · Complete" : ""}
					</p>
					<progress value={epic.done} max={epic.total || 1} aria-label='Epic completion' />
				</>
			)}
			{(error || failure) && (
				<p role='alert'>
					{failure || error}{" "}
					<button disabled={busy} onClick={refresh}>
						Refresh
					</button>
				</p>
			)}
			<form
				onSubmit={(event) => {
					event.preventDefault();
					const parsed = editEpicSchema.safeParse({ title, description });
					if (!parsed.success) {
						setFailure("Enter a title up to 120 characters and a description up to 4000 characters.");
						return;
					}
					setFailure("");
					void save(parsed.data).catch((err: unknown) =>
						setFailure(err instanceof Error ? err.message : "Cannot save epic. Retry."),
					);
				}}
			>
				<label>
					Title
					<input
						aria-label='Title'
						required
						maxLength={120}
						value={title}
						disabled={busy}
						onChange={(event) => setTitle(event.target.value)}
					/>
				</label>
				<label>
					Description
					<textarea
						aria-label='Description'
						rows={7}
						maxLength={4000}
						value={description}
						disabled={busy}
						onChange={(event) => setDescription(event.target.value)}
					/>
				</label>
				<div className='ticket-dialog-actions'>
					<button type='button' disabled={busy} onClick={close}>
						Close
					</button>
					<button className='primary' disabled={busy}>
						{epic ? "Save epic" : "Create"}
					</button>
				</div>
			</form>
			{epic && (
				<>
					<h3>Children</h3>
					<button disabled={busy} onClick={create}>
						Create ticket
					</button>
					<ul>
						{tickets.map((ticket) => (
							<li key={ticket.id}>
								<button onClick={() => open(ticket)}>
									{ticket.id} {ticket.title}
								</button>{" "}
								· {ticketLabels[ticket.status]}
							</li>
						))}
					</ul>
					{!tickets.length && <p>No tickets in this epic.</p>}
				</>
			)}
		</dialog>
	);
};
