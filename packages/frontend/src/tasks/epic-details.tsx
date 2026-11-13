import { editEpicSchema, type EditEpic, type EpicSummary, type Ticket } from "@forge/contracts/tickets";
import { useEffect, useRef, useState } from "react";

import { Dropdown, DropdownOption } from "../dropdown.tsx";
import { useErrorState } from "../toasts/toasts.tsx";
import { EpicIcon } from "./epic-icon.tsx";
import { InlineTicketDescription, InlineTicketTitle } from "./inline-ticket-fields.tsx";
import { ticketLabels } from "./ticket-labels.ts";
import { EpicProgress, TicketTable } from "./ticket-table.tsx";

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
		<Dropdown aria-label='Epic' value={value ?? ""} disabled={disabled} onChange={(value) => change(value || null)}>
			<DropdownOption value=''>No epic</DropdownOption>
			{value && !epics.some((epic) => epic.id === value) && (
				<DropdownOption value={value} icon={<EpicIcon />}>
					{value}
				</DropdownOption>
			)}
			{epics.map((epic) => (
				<DropdownOption
					key={epic.id}
					value={epic.id}
					icon={<EpicIcon />}
					matchingLabel={`${epic.id}\n${epic.title}`}
				>
					{epic.id} · {epic.title}
				</DropdownOption>
			))}
		</Dropdown>
	</label>
);

const useEpicField = <Element extends HTMLElement>(
	value: string,
	busy: boolean,
	persist: (value: string) => Promise<void>,
) => {
	const [draft, change] = useState<string>();
	const [error, setError] = useErrorState();
	const trigger = useRef<HTMLButtonElement>(null);
	const input = useRef<Element>(null);
	const restoreFocus = useRef(false);
	const editing = draft !== undefined;
	useEffect(() => {
		if (editing) input.current?.focus();
		else if (!busy && restoreFocus.current) {
			restoreFocus.current = false;
			trigger.current?.focus();
		}
	}, [editing, busy]);
	const discard = () => {
		restoreFocus.current = true;
		setError("");
		change(undefined);
	};
	const save = async () => {
		if (draft === undefined || busy) return;
		setError("");
		try {
			if (draft !== value) await persist(draft);
			discard();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Cannot save epic. Retry.");
		}
	};
	return {
		props: { value, draft, editable: true, busy, trigger, input, change, save: () => void save(), discard },
		error,
	};
};

const EpicFields = ({
	epic,
	busy,
	save,
}: {
	epic: EpicSummary;
	busy: boolean;
	save: (input: EditEpic) => Promise<void>;
}) => {
	const title = useEpicField<HTMLInputElement>(epic.title, busy, async (value) => {
		const parsed = editEpicSchema.safeParse({ title: value, description: epic.description });
		if (!parsed.success) throw new Error("Enter a title up to 120 characters.");
		if (parsed.data.title !== epic.title) await save(parsed.data);
	});
	const description = useEpicField<HTMLTextAreaElement>(epic.description, busy, (value) =>
		save(editEpicSchema.parse({ title: epic.title, description: value })),
	);
	return (
		<>
			<InlineTicketTitle {...title.props} invalid={!!title.error} />

			<InlineTicketDescription {...description.props} />
		</>
	);
};

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
	const [title, setTitle] = useState("");
	const [description, setDescription] = useState("");
	const [failure, setFailure] = useErrorState();
	const status = epic?.complete
		? "done"
		: epic?.counts["in-progress"] || epic?.done
			? "in-progress"
			: epic?.counts.todo
				? "todo"
				: "backlog";
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	return (
		<dialog
			ref={dialog}
			className={epic ? "ticket-dialog epic-details" : "ticket-dialog"}
			aria-labelledby='epic-dialog-title'
			onCancel={(event) => {
				event.preventDefault();
				if (!busy) close();
			}}
		>
			<div className={epic ? "ticket-details-heading" : "ticket-dialog-heading"}>
				{epic ? (
					<div className='ticket-details-key-row'>
						<h2 id='epic-dialog-title'>
							<EpicIcon />
							{epic.id}
						</h2>
						<span className={`ticket-status-select epic-status ticket-status-${status}`}>
							{ticketLabels[status]}
						</span>
					</div>
				) : (
					<h2 id='epic-dialog-title'>Create epic</h2>
				)}
				<button disabled={busy} onClick={close} aria-label='Close epic'>
					✕
				</button>
			</div>
			{(error || failure) && (
				<p>
					<button disabled={busy} onClick={refresh}>
						Refresh
					</button>
				</p>
			)}
			{epic ? (
				<EpicFields epic={epic} busy={busy} save={save} />
			) : (
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
							Create
						</button>
					</div>
				</form>
			)}
			{epic && (
				<section className='backlog-section epic-children'>
					<div className='backlog-section-header'>
						<h3 id='epic-children-title'>Child work items</h3>
						<EpicProgress done={epic.done} total={epic.total} />
						<button className='backlog-epic-create' disabled={busy} onClick={create}>
							<span aria-hidden='true'>+</span> Create ticket
						</button>
					</div>
					<TicketTable
						tickets={tickets}
						labelId='epic-children-title'
						busy={busy}
						open={open}
						emptyMessage='No tickets in this epic.'
					/>
				</section>
			)}
		</dialog>
	);
};
