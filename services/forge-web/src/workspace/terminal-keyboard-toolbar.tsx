import { arrowInput } from "./terminal-keyboard.ts";

export const TerminalKeyboardToolbar = ({
	connected,
	control,
	toggleControl,
	input,
}: {
	connected: boolean;
	control: boolean;
	toggleControl: () => void;
	input: (value: string | ((application: boolean) => string)) => void;
}) => (
	<div
		className='terminal-keyboard-toolbar'
		role='toolbar'
		aria-label='Terminal keyboard'
		onPointerDown={(event) => event.preventDefault()}
		onMouseDown={(event) => event.preventDefault()}
	>
		{(
			[
				["^R", "Control R", "\x12"],
				["^C", "Control C", "\x03"],
				["Esc", "Escape", "\x1b"],
				["Tab", "Tab", "\t"],
			] as const
		).map(([text, label, value]) => (
			<button key={label} type='button' disabled={!connected} aria-label={label} onClick={() => input(value)}>
				{text}
			</button>
		))}
		<button
			type='button'
			disabled={!connected}
			aria-label='Control modifier'
			aria-pressed={control}
			onClick={toggleControl}
		>
			Ctrl
		</button>
		{(
			[
				["←", "Left", "D"],
				["↑", "Up", "A"],
				["↓", "Down", "B"],
				["→", "Right", "C"],
			] as const
		).map(([text, label, direction]) => (
			<button
				key={label}
				type='button'
				disabled={!connected}
				aria-label={`${label} arrow`}
				onClick={() => input((application) => arrowInput(direction, application))}
			>
				{text}
			</button>
		))}
	</div>
);
