import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
	type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { ToastQueue, type ToastVariant } from "./toast-queue.ts";

const ToastContext = createContext<ToastQueue | null>(null);
export const ToastVisibility = createContext(true);
export const useToast = () => {
	const queue = useContext(ToastContext);
	const visible = useContext(ToastVisibility);
	const enabled = useRef(visible);
	useLayoutEffect(() => {
		enabled.current = visible;
		return () => {
			enabled.current = false;
		};
	}, [visible]);
	const notify = useCallback(
		(message: string, variant?: ToastVariant) => {
			if (enabled.current) queue?.notify(message, variant);
		},
		[queue],
	);
	if (!queue) throw new Error("ToastProvider is required");
	return { notify };
};

/** Report attempts at their source, including consecutive equal failures. Retain local control state. */
export const useErrorState = (initial = "") => {
	const [value, update] = useState(initial);
	const { notify } = useToast();
	const mounted = useRef(false);
	useLayoutEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const set = useCallback(
		(message: string) => {
			if (!mounted.current) return;
			update(message);
			if (message) notify(message);
		},
		[notify],
	);
	return [value, set] as const;
};

/** Durable/polled failures announce on first display and meaningful changes only. */
export const useFailureToast = (message: string | null | undefined, identity?: string) => {
	const { notify } = useToast();
	const visible = useContext(ToastVisibility);
	const previous = useRef("");
	useEffect(() => {
		const key = visible && message ? JSON.stringify([identity, message]) : "";
		if (key && previous.current !== key) notify(message!);
		previous.current = key;
	}, [message, identity, notify, visible]);
};

const anchors = new Set<HTMLElement>();
export const useToastAnchor = (ref: RefObject<HTMLElement | null>) => {
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		anchors.add(element);
		return () => {
			anchors.delete(element);
		};
	}, [ref]);
};

const ToastViewport = () => {
	const queue = useContext(ToastContext)!;
	const active = useSyncExternalStore(queue.subscribe, queue.snapshot);
	const viewport = useRef<HTMLDivElement>(null);
	// Move the same DOM node between hosts: animation, deadline and keyboard focus survive rehosting.
	const [host] = useState(() => document.createElement("div"));
	useLayoutEffect(() => {
		const modals: HTMLDialogElement[] = [];
		const rehost = () => {
			const active = queue.snapshot();
			for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog:modal")) {
				if (!modals.includes(dialog)) modals.push(dialog);
			}
			for (let i = modals.length - 1; i >= 0; i--) {
				if (!modals[i]?.isConnected || !modals[i]?.matches(":modal")) modals.splice(i, 1);
			}
			const parent = modals.at(-1) ?? document.body;
			if (host.parentElement !== parent) {
				if (viewport.current?.matches(":popover-open")) viewport.current.hidePopover();
				parent.append(host);
			}
			if (active && viewport.current && !viewport.current.matches(":popover-open"))
				viewport.current.showPopover();
			if (!active && viewport.current?.matches(":popover-open")) viewport.current.hidePopover();
			// Reparenting and reopening a popover can restart CSS animations. Synchronize
			// their playheads with the existing deadline, without changing animation delay.
			if (active) {
				const elapsed = Math.max(0, 3000 - (active.deadline - Date.now()));
				for (const animation of viewport.current?.getAnimations({ subtree: true }) ?? []) {
					if (animation instanceof CSSAnimation && animation.animationName.startsWith("forge-toast-"))
						animation.currentTime = elapsed;
				}
			}
			measure();
		};
		const measure = () => {
			const node = viewport.current;
			if (!node) return;
			const visual = window.visualViewport;
			const bottom = (visual?.offsetTop ?? 0) + (visual?.height ?? window.innerHeight);
			let top = bottom - 16;
			if (window.innerWidth <= 600) {
				for (const anchor of anchors) {
					const modal = modals.at(-1);
					if (modal && !modal.contains(anchor)) continue;
					const rect = anchor.getBoundingClientRect();
					if (
						anchor.checkVisibility({ visibilityProperty: true, opacityProperty: true })
						&& !anchor.closest("[hidden], [inert]")
						&& rect.bottom > (visual?.offsetTop ?? 0)
						&& rect.top < bottom
						&& rect.width > 0
					)
						top = Math.min(top, rect.top - 8);
				}
			}
			node.style.setProperty("--toast-bottom", `${Math.max(16, window.innerHeight - top)}px`);
			node.style.setProperty("--toast-left", `${(visual?.offsetLeft ?? 0) + 16}px`);
			node.style.setProperty("--toast-width", `${visual?.width ?? window.innerWidth}px`);
		};
		const resize = new ResizeObserver(measure);
		resize.observe(document.body);
		const observed = new Set<HTMLElement>();
		const observe = () => {
			for (const anchor of observed) {
				if (!anchors.has(anchor)) {
					resize.unobserve(anchor);
					observed.delete(anchor);
				}
			}
			for (const anchor of anchors) {
				resize.observe(anchor);
				observed.add(anchor);
			}
			rehost();
		};
		const mutations = new MutationObserver((records) => {
			for (const record of records) {
				if (record.attributeName !== "open" || record.oldValue !== null) continue;
				const dialog = record.target;
				if (!(dialog instanceof HTMLDialogElement) || !dialog.matches(":modal")) continue;
				const index = modals.indexOf(dialog);
				if (index >= 0) modals.splice(index, 1);
				modals.push(dialog);
			}
			observe();
		});
		mutations.observe(document.body, {
			subtree: true,
			childList: true,
			attributes: true,
			attributeFilter: ["open", "hidden", "class", "inert"],
			attributeOldValue: true,
		});
		document.addEventListener("toggle", rehost, true);
		document.addEventListener("close", rehost, true);
		window.addEventListener("scroll", measure, true);
		window.addEventListener("resize", measure);
		window.visualViewport?.addEventListener("resize", measure);
		window.visualViewport?.addEventListener("scroll", measure);
		observe();
		const unsubscribe = queue.subscribe(rehost);
		return () => {
			unsubscribe();
			resize.disconnect();
			mutations.disconnect();
			document.removeEventListener("toggle", rehost, true);
			document.removeEventListener("close", rehost, true);
			window.removeEventListener("scroll", measure, true);
			window.removeEventListener("resize", measure);
			window.visualViewport?.removeEventListener("resize", measure);
			window.visualViewport?.removeEventListener("scroll", measure);
			host.remove();
		};
	}, [host, queue]);
	return createPortal(
		<div ref={viewport} popover='manual' className='forge-toast-viewport'>
			{active && (
				<button
					type='button'
					key={active.id}
					className={`forge-toast ${active.variant}`}
					onClick={(event) => {
						event.stopPropagation();
						queue.dismiss();
					}}
					aria-label='Dismiss notification'
				>
					<span key={active.revision} className='forge-toast-sweep' aria-hidden='true' />
					<span role={active.variant === "error" ? "alert" : "status"} aria-atomic='true'>
						{active.count > 1 ? `${active.count}x ` : ""}
						{active.message}
					</span>
				</button>
			)}
		</div>,
		host,
	);
};

export const ToastProvider = ({ children }: { children: ReactNode }) => {
	const [queue] = useState(() => new ToastQueue());
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		let validating = false;
		const invalid = (event: Event) => {
			const field = event.target;
			if (
				!(
					field instanceof HTMLInputElement
					|| field instanceof HTMLTextAreaElement
					|| field instanceof HTMLSelectElement
				)
			)
				return;
			event.preventDefault();
			if (!validating) {
				validating = true;
				queue.notify(field.validationMessage);
				queueMicrotask(() => {
					validating = false;
				});
			}
		};
		document.addEventListener("invalid", invalid, true);
		return () => {
			document.removeEventListener("invalid", invalid, true);
			mounted.current = false;
			queueMicrotask(() => {
				if (!mounted.current) queue.dispose();
			});
		};
	}, [queue]);
	return (
		<ToastContext value={queue}>
			{children}
			<ToastViewport />
		</ToastContext>
	);
};
