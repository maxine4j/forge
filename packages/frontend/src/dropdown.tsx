import {
	Children,
	isValidElement,
	useEffect,
	useId,
	useRef,
	useState,
	type CSSProperties,
	type ReactNode,
} from "react";

export interface DropdownChoice {
	value: string;
	label: ReactNode;
	matchingLabel: string;
	icon?: ReactNode;
	disabled?: boolean;
}

// Declarative options are converted to data; they never render native option elements.
export const DropdownOption = (_props: {
	value?: string | number;
	children: ReactNode;
	disabled?: boolean;
	icon?: ReactNode;
	matchingLabel?: string;
}) => null;
const plainText = (node: ReactNode): string =>
	Children.toArray(node)
		.map((child): string =>
			isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : String(child),
		)
		.join("");

export const DropdownSurface = ({
	label,
	disabled = false,
	className = "",
	trigger,
	children,
	listbox = false,
	onKeyDown,
	activeId,
	onOpen,
	dismissWhenDisabled = true,
	popupLabel = label,
	size,
}: {
	label: string;
	disabled?: boolean;
	className?: string;
	trigger: ReactNode;
	children: (close: (restore?: boolean) => void, open: boolean) => ReactNode;
	listbox?: boolean;
	onKeyDown?: (
		event: React.KeyboardEvent,
		open: boolean,
		show: () => void,
		close: (restore?: boolean) => void,
	) => void;
	activeId?: string;
	onOpen?: () => void;
	dismissWhenDisabled?: boolean;
	popupLabel?: string;
	size?: "toolbar";
}) => {
	const id = useId();
	const anchor = `--dropdown-${id.replace(/[^a-zA-Z0-9]/gu, "")}`;
	const button = useRef<HTMLButtonElement>(null);
	const popup = useRef<HTMLDivElement>(null);
	const focusedControl = useRef<HTMLElement | null>(null);
	const [open, setOpen] = useState(false);
	const [restoreFocus, setRestoreFocus] = useState(false);
	const matching = useRef({ text: "", time: 0 });
	const close = (restore = false) => {
		document.getElementById(id)?.hidePopover();
		setOpen(false);
		if (restore) {
			document.getElementById(`${id}-trigger`)?.focus();
			setRestoreFocus(true);
		}
	};
	const show = () => {
		if (button.current?.matches(":disabled")) return;
		matching.current = { text: "", time: 0 };
		onOpen?.();
		popup.current?.showPopover();
		setOpen(true);
	};
	useEffect(() => {
		if (open && activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
	}, [open, activeId]);
	useEffect(() => {
		if (!open && !restoreFocus) return;
		const check = () => {
			const isDisabled = button.current?.matches(":disabled");
			if (dismissWhenDisabled && isDisabled) popup.current?.hidePopover();
			// Multiselect saves temporarily disable checkboxes without dismissing the surface.
			if (
				!listbox
				&& popup.current?.matches(":popover-open")
				&& !isDisabled
				&& document.activeElement === document.body
				&& focusedControl.current?.matches(":enabled")
			)
				focusedControl.current.focus();
			if (restoreFocus && !isDisabled) {
				if (document.activeElement === document.body || document.activeElement === button.current)
					button.current?.focus();
				setRestoreFocus(false);
			}
		};
		check();
		const observer = new MutationObserver(check);
		observer.observe(document.documentElement, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["disabled"],
		});
		const cancelRestore = () => setRestoreFocus(false);
		if (restoreFocus) document.addEventListener("pointerdown", cancelRestore);
		return () => {
			observer.disconnect();
			document.removeEventListener("pointerdown", cancelRestore);
		};
	}, [disabled, dismissWhenDisabled, restoreFocus, open, listbox]);
	const keys = (event: React.KeyboardEvent) => {
		if (event.key === "Escape" && open) {
			event.preventDefault();
			event.stopPropagation();
			close(true);
		} else if (event.key === "Tab" && open) {
			button.current?.focus();
			close();
		} else if (!listbox) {
			const controls = Array.from(
				popup.current?.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
					"input:not(:disabled), button:not(:disabled)",
				) ?? [],
			);
			const index = controls.indexOf(document.activeElement as HTMLInputElement);
			if (
				["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
				|| (!open && ["Enter", " "].includes(event.key))
			) {
				event.preventDefault();
				if (!open) show();
				controls[
					event.key === "End"
						? controls.length - 1
						: event.key === "Home"
							? 0
							: index < 0
								? event.key === "ArrowUp"
									? controls.length - 1
									: 0
								: (index + (event.key === "ArrowUp" ? -1 : 1) + controls.length) % controls.length
				]?.focus();
			} else if (
				event.key.length === 1
				&& event.key !== " "
				&& !event.ctrlKey
				&& !event.metaKey
				&& !event.altKey
			) {
				event.preventDefault();
				if (!open) show();
				const match = prefixMatch(
					controls,
					index,
					event.key,
					matching.current,
					(control) => control.closest("label")?.textContent?.trim() ?? control.textContent ?? "",
				);
				match?.focus();
			}
		} else onKeyDown?.(event, open, show, close);
	};
	return (
		<>
			<button
				ref={button}
				id={`${id}-trigger`}
				type='button'
				role={listbox ? "combobox" : undefined}
				aria-label={label}
				aria-haspopup={listbox ? "listbox" : undefined}
				aria-expanded={open}
				aria-controls={id}
				aria-activedescendant={open ? activeId : undefined}
				disabled={disabled}
				className={`dropdown-trigger ${size === "toolbar" ? "toolbar-button" : ""} ${className}`}
				style={{ anchorName: anchor } as CSSProperties}
				onKeyDown={keys}
				onClick={() => (open ? close() : show())}
			>
				{trigger}
				<span className='ticket-chevron' aria-hidden='true' />
			</button>
			<div
				ref={popup}
				id={id}
				popover='auto'
				role={listbox ? "listbox" : "group"}
				aria-label={popupLabel}
				className='dropdown-surface'
				onFocusCapture={(event) => {
					focusedControl.current = event.target as HTMLElement;
				}}
				style={{ positionAnchor: anchor } as CSSProperties}
				onToggle={(event) => setOpen(event.newState === "open")}
				onKeyDown={keys}
			>
				{children(close, open)}
			</div>
		</>
	);
};

export const Dropdown = ({
	value,
	onChange,
	options,
	children,
	disabled,
	className,
	trigger,
	emptyLabel = "No options available.",
	size,
	"aria-label": label,
}: {
	value: string | number;
	onChange: (value: string) => void;
	options?: DropdownChoice[];
	children?: ReactNode;
	disabled?: boolean;
	className?: string;
	trigger?: ReactNode;
	emptyLabel?: string;
	size?: "toolbar";
	"aria-label": string;
}) => {
	const choices: DropdownChoice[] =
		options
		?? Children.toArray(children)
			.filter(isValidElement)
			.map((child) => {
				const props = (child as React.ReactElement<Parameters<typeof DropdownOption>[0]>).props;
				const text = plainText(props.children).trim();
				return {
					value: String(props.value ?? text),
					label: props.children,
					matchingLabel: props.matchingLabel ?? text,
					icon: props.icon,
					disabled: props.disabled,
				};
			});
	const selected = choices.find((option) => option.value === String(value));
	const [active, setActive] = useState<string>();
	const id = useId();
	const matching = useRef({ text: "", time: 0 });
	const activeIndex = choices.findIndex((option) => option.value === active && !option.disabled);
	const activeId = activeIndex < 0 ? undefined : `${id}-${activeIndex}`;
	const render = (option: DropdownChoice) => (
		<>
			{option.icon && (
				<span aria-hidden='true' className='dropdown-icon'>
					{option.icon}
				</span>
			)}
			<span className='dropdown-label'>{option.label}</span>
		</>
	);
	return (
		<DropdownSurface
			size={size}
			label={label}
			disabled={disabled}
			className={className}
			listbox
			activeId={activeId}
			onOpen={() => {
				matching.current = { text: "", time: 0 };
				setActive(selected?.disabled ? undefined : selected?.value);
			}}
			trigger={trigger ?? (selected ? render(selected) : String(value))}
			onKeyDown={(event, open, show, close) => {
				const enabled = choices.filter((option) => !option.disabled);
				const key = event.key;
				if (!enabled.length) {
					if (["Enter", " ", "ArrowDown", "ArrowUp"].includes(key)) {
						event.preventDefault();
						if (!open) show();
					}
					return;
				}
				if (["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(key)) {
					event.preventDefault();
					if (!open) {
						matching.current = { text: "", time: 0 };
						show();
						setActive(
							(selected && !selected.disabled
								? selected
								: key === "ArrowUp"
									? enabled.at(-1)
									: enabled[0]
							)?.value,
						);
					} else if (key === "Enter" || key === " ") {
						if (activeIndex >= 0) {
							close(true);
							if (active !== String(value)) onChange(active!);
						}
					} else {
						const index = enabled.findIndex((option) => option.value === active);
						setActive(
							enabled[
								key === "Home"
									? 0
									: key === "End"
										? enabled.length - 1
										: index < 0
											? key === "ArrowUp"
												? enabled.length - 1
												: 0
											: (index + (key === "ArrowUp" ? -1 : 1) + enabled.length) % enabled.length
							]?.value,
						);
					}
				} else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
					event.preventDefault();
					const start = enabled.findIndex((option) => option.value === (open ? active : String(value)));
					if (!open) show();
					const match = prefixMatch(enabled, start, key, matching.current, (option) => option.matchingLabel);
					if (match) setActive(match.value);
				}
			}}
		>
			{(close, open) => (
				<>
					{choices.length === 0 && <p className='dropdown-empty'>{emptyLabel}</p>}
					{choices.map((option, index) => (
						<div
							key={option.value}
							id={`${id}-${index}`}
							role='option'
							aria-selected={option.value === String(value)}
							aria-disabled={option.disabled || undefined}
							data-value={option.value}
							data-active={(open && option.value === active) || undefined}
							className='dropdown-option'
							onPointerMove={() => {
								if (!option.disabled) setActive(option.value);
							}}
							onMouseDown={(event) => event.preventDefault()}
							onClick={(event) => {
								event.preventDefault();
								if (option.disabled) return;
								close(true);
								if (option.value !== String(value)) onChange(option.value);
							}}
						>
							{render(option)}
						</div>
					))}
				</>
			)}
		</DropdownSurface>
	);
};

function prefixMatch<T>(
	items: T[],
	start: number,
	key: string,
	buffer: { text: string; time: number },
	label: (item: T) => string,
): T | undefined {
	const now = Date.now();
	buffer.text = (now - buffer.time < 700 ? buffer.text : "") + key.toLowerCase();
	buffer.time = now;
	const repeated = [...buffer.text].every((character) => character === buffer.text[0]);
	const prefix = repeated ? buffer.text[0]! : buffer.text;
	const offset = Math.max(0, start + (repeated ? 1 : 0));
	return [...items.slice(offset), ...items.slice(0, offset)].find((item) =>
		label(item)
			.toLowerCase()
			.split("\n")
			.some((text) => text.startsWith(prefix)),
	);
}
