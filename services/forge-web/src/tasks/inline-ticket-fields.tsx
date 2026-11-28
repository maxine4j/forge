import { useId, type Ref } from "react";

import { TicketTextPreview } from "./ticket-text-preview.tsx";

type InlineFieldProps<Element> = {
	value: string;
	draft: string | undefined;
	editable: boolean;
	busy: boolean;
	trigger: Ref<HTMLButtonElement>;
	input: Ref<Element>;
	change: (value: string) => void;
	save: () => void;
	discard: () => void;
};

const InlineFieldActions = ({ field, busy, discard }: { field: string; busy: boolean; discard: () => void }) => (
	<>
		<button type='submit' aria-label={`Save ${field}`} title={`Save ${field}`} disabled={busy}>
			✓
		</button>
		<button
			type='button'
			aria-label={`Discard ${field} changes`}
			title={`Discard ${field} changes`}
			disabled={busy}
			onClick={discard}
		>
			✕
		</button>
	</>
);

export const InlineTicketTitle = ({
	value,
	draft,
	editable,
	busy,
	trigger,
	input,
	change,
	save,
	discard,
	invalid,
}: InlineFieldProps<HTMLInputElement> & { invalid: boolean }) =>
	editable && draft !== undefined ? (
		<form
			className='ticket-title-editor'
			onSubmit={(event) => {
				event.preventDefault();
				save();
			}}
		>
			<input
				ref={input}
				aria-label='Title'
				aria-invalid={invalid || undefined}
				maxLength={120}
				value={draft}
				readOnly={busy}
				onChange={(event) => change(event.target.value)}
			/>
			<InlineFieldActions field='title' busy={busy} discard={discard} />
		</form>
	) : (
		<h3 className='ticket-title'>
			{editable ? (
				<button
					ref={trigger}
					type='button'
					aria-label={`Edit title: ${value}`}
					title='Edit title'
					disabled={busy}
					onClick={() => change(value)}
				>
					{value}
				</button>
			) : (
				value
			)}
		</h3>
	);

export const InlineTicketDescription = ({
	value,
	draft,
	editable,
	busy,
	trigger,
	input,
	change,
	save,
	discard,
	markdown = false,
}: InlineFieldProps<HTMLTextAreaElement> & { markdown?: boolean }) => {
	const label = useId();
	const editing = editable && draft !== undefined;
	return (
		<form
			className='ticket-description-editor'
			onSubmit={(event) => {
				event.preventDefault();
				save();
			}}
		>
			<fieldset className='ticket-detail-section'>
				<legend id={label}>Description</legend>
				{editing ? (
					<div className='ticket-description-edit'>
						<textarea
							ref={input}
							className='ticket-description-text'
							aria-labelledby={label}
							rows={1}
							maxLength={4000}
							value={draft}
							readOnly={busy}
							onChange={(event) => change(event.target.value)}
						/>
						<div className='ticket-description-actions'>
							<InlineFieldActions field='description' busy={busy} discard={discard} />
						</div>
					</div>
				) : markdown ? (
					<TicketTextPreview text={value || (editable ? "Add a description" : "No description")}>
						{(content) => (
							<div className='ticket-description-preview'>
								{editable && (
									<button ref={trigger} type='button' disabled={busy} onClick={() => change(value)}>
										Edit description
									</button>
								)}
								<div
									className='ticket-plan-markdown'
									onClick={(event) => {
										if (editable && !busy && !(event.target as Element).closest("a")) change(value);
									}}
								>
									{content}
								</div>
							</div>
						)}
					</TicketTextPreview>
				) : editable ? (
					<button
						ref={trigger}
						className='ticket-description-text'
						type='button'
						aria-label='Edit description'
						title='Edit description'
						disabled={busy}
						onClick={() => change(value)}
					>
						{value || "Add a description"}
					</button>
				) : (
					<p className='ticket-description-text'>{value || "No description"}</p>
				)}
			</fieldset>
		</form>
	);
};
