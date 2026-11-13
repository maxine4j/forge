import {
	createContext,
	useContext,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ReactNode,
	type RefObject,
	type SyntheticEvent,
	type KeyboardEvent,
} from "react";
import { useBlocker, useLocation, useNavigate, type Location, type NavigateFunction } from "react-router";

import type { NavigationState, ModalOwner } from "./types.ts";

// Imperative actions can arrive between a router transition and React's commit.
// Read the router at action time so rapid input never uses an older modal depth.
export const NavigationRouter = createContext<{ state: { location: Location } } | null>(null);
export const navigationState = (location: Pick<Location, "state">): NavigationState =>
	(location.state as NavigationState | null) ?? {};
export const retainsModal = (location: Location, id: string): boolean => {
	let modal = navigationState(location).modal;
	while (modal) {
		if (modal.id === id) return true;
		modal = modal.parent.state.modal;
	}
	return false;
};
export const nextModal = (location: Location, owner: ModalOwner, selection?: string): NavigationState => ({
	modal: {
		id: crypto.randomUUID(),
		owner,
		depth: 1,
		parent: { url: location.pathname + location.search + location.hash, state: navigationState(location) },
		...(selection === undefined ? {} : { selection }),
	},
});
export const advanceModal = (state: NavigationState): NavigationState =>
	state.modal ? { ...state, modal: { ...state.modal, depth: state.modal.depth + 1 } } : state;

export const dismissalDepth = (state: NavigationState, owner: string | undefined = state.modal?.owner): number => {
	let modal = state.modal;
	let depth = 0;
	while (modal) {
		depth += modal.depth;
		if (modal.owner === owner) return depth;
		modal = modal.parent.state.modal;
	}
	return 0;
};

export const directModalParent = (location: Location): Location | undefined => {
	const query = new URLSearchParams(location.search);
	if (
		location.pathname !== "/tasks"
		|| navigationState(location).modal
		|| (!query.has("ticket") && !query.has("epic"))
	)
		return;
	query.delete("ticket");
	query.delete("epic");
	query.delete("tab");
	return { ...location, search: query.size ? `?${query}` : "", state: null };
};

type Guard = { blocks: (next: Location) => boolean; discard?: () => void; hard?: boolean };
const Guards = createContext<Map<symbol, { current: Guard }>>(new Map());
const Reading = createContext<Map<string, number>>(new Map());

export const NavigationProvider = ({ children }: { children: ReactNode }) => {
	const location = useLocation();
	const [guards] = useState(() => new Map<symbol, { current: Guard }>());
	const [reading] = useState(() => new Map<string, number>());
	const affected = useRef<Guard[]>([]);
	useEffect(() => {
		for (const popover of document.querySelectorAll<HTMLElement>(
			"[popover]:not([popover='manual']):popover-open",
		)) {
			if (popover.closest("[hidden]")) popover.hidePopover();
		}
	}, [location.key]);
	const blocker = useBlocker(({ nextLocation }) => {
		affected.current = [...guards.values()]
			.map((guard) => guard.current)
			.filter((guard) => guard.blocks(nextLocation));
		return affected.current.length > 0;
	});
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		if (blocker.state !== "blocked") return;
		if (affected.current.some((guard) => guard.hard)) blocker.reset();
		else dialog.current?.showModal();
	}, [blocker]);
	const keep = () => {
		dialog.current?.close();
		if (blocker.state === "blocked") blocker.reset();
	};
	return (
		<Guards.Provider value={guards}>
			<Reading.Provider value={reading}>
				{children}
				<dialog
					ref={dialog}
					className='ticket-dialog ticket-archive-dialog'
					aria-label='Unsaved changes'
					onCancel={(event) => {
						event.preventDefault();
						keep();
					}}
				>
					<h2>Discard unsaved changes?</h2>
					<div className='ticket-dialog-actions'>
						<button type='button' onClick={keep}>
							Keep editing
						</button>
						<button
							type='button'
							onClick={() => {
								for (const guard of affected.current) guard.discard?.();
								dialog.current?.close();
								if (blocker.state === "blocked") blocker.proceed();
							}}
						>
							Discard changes
						</button>
					</div>
				</dialog>
			</Reading.Provider>
		</Guards.Provider>
	);
};

export const useNavigationGuard = (guard: Guard) => {
	const guards = useContext(Guards);
	const [key] = useState(() => Symbol());
	const current = useRef(guard);
	useLayoutEffect(() => {
		current.current = guard;
	});
	useEffect(() => {
		guards.set(key, current);
		return () => {
			guards.delete(key);
		};
	}, [guards, key]);
};

export const useModalDialog = (ref: RefObject<HTMLDialogElement | null>, visible = true) => {
	const location = useLocation();
	let modal = navigationState(location).modal;
	while (modal && ["archive", "return"].includes(modal.owner)) modal = modal.parent.state.modal;
	const id = modal?.id;
	const reading = useContext(Reading);
	useLayoutEffect(() => {
		const dialog = ref.current;
		if (!visible || !dialog) return;
		const opener = document.activeElement;
		dialog.showModal();
		if (id) dialog.scrollTop = reading.get(id) ?? 0;
		return () => {
			if (id) reading.set(id, dialog.scrollTop);
			dialog.close();
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
		};
	}, [ref, visible, id, reading]);
};

export const createModalNavigation = (currentLocation: () => Location, navigate: NavigateFunction) => {
	return {
		open: (owner: ModalOwner, url?: string, selection?: string) => {
			const current = currentLocation();
			const target = url ?? current.pathname + current.search;
			const modal = navigationState(current).modal;
			if (target === current.pathname + current.search && modal?.owner === owner && modal.selection === selection)
				return;
			void navigate(target, { state: nextModal(current, owner, selection) });
		},
		select: (url: string, replace = false, expectedKey?: string) => {
			const current = currentLocation();
			if (expectedKey !== undefined && current.key !== expectedKey) return;
			if (url === current.pathname + current.search && !replace) return;
			const latest = navigationState(current);
			void navigate(url, { replace, state: replace ? latest : advanceModal(latest) });
		},
		replace: (owner: ModalOwner, url: string) => {
			const latest = navigationState(currentLocation());
			if (latest.modal)
				void navigate(url, { replace: true, state: { ...latest, modal: { ...latest.modal, owner } } });
		},
		dismiss: () => {
			const latest = navigationState(currentLocation());
			if (latest.modal) void navigate(-latest.modal.depth);
		},
		dismissOwner: (owner: string) => {
			const depth = dismissalDepth(navigationState(currentLocation()), owner);
			if (depth) void navigate(-depth);
		},
		completeConfirmation: async (owner?: ModalOwner) => {
			const latest = navigationState(currentLocation());
			const modal = latest.modal;
			if (!modal) return;
			const depth = dismissalDepth(latest, owner);
			// Retire the action entry before traversing. Forward can restore a view,
			// but cannot restore a confirmation for an already completed action.
			await navigate(modal.parent.url, { replace: true, state: advanceModal(modal.parent.state) });
			if (depth) await navigate(-depth);
		},
		back: () => void navigate(-1),
	};
};

export const useModalNavigation = () => {
	const location = useLocation();
	const navigate = useNavigate();
	const router = useContext(NavigationRouter);
	return {
		modal: navigationState(location).modal,
		...createModalNavigation(() => router?.state.location ?? location, navigate),
	};
};

export const useDialogDismissal = (busy: boolean) => {
	const navigation = useModalNavigation();
	const keyboardEscape = useRef(false);
	return {
		onCancel: (event: SyntheticEvent<HTMLDialogElement>) => {
			event.preventDefault();
			event.stopPropagation();
			// A native Back cancellation consumes exactly one router entry. Prevent
			// the browser from also closing the dialog independently of that entry.
			const escape = keyboardEscape.current;
			keyboardEscape.current = false;
			if (!busy) {
				if (escape) navigation.dismiss();
				else navigation.back();
			}
		},
		onKeyDown: (event: KeyboardEvent<HTMLDialogElement>) => {
			if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
			// Let the native close watcher dismiss an open picker before the dialog.
			// Manual popovers (including error toasts) do not consume Escape.
			if (event.currentTarget.querySelector("[popover]:not([popover='manual']):popover-open")) return;
			// Native cancel is the sole navigation trigger. Navigating here as well
			// can let the same Escape dismiss a newly opened draft confirmation.
			keyboardEscape.current = true;
			event.stopPropagation();
		},
		onKeyUp: (event: KeyboardEvent<HTMLDialogElement>) => {
			// A native picker may consume Escape without cancelling the dialog.
			if (event.key === "Escape") keyboardEscape.current = false;
		},
	};
};

// Tabs and confirmations retain the form. Other modal transitions may unmount it.
export const useModalDraft = (dirty: boolean, busy: boolean, discard?: () => void) => {
	const location = useLocation();
	let owner = navigationState(location).modal;
	while (owner && ["archive", "return"].includes(owner.owner)) owner = owner.parent.state.modal;
	const id = owner?.id;
	const released = useRef<"all" | "busy" | undefined>(undefined);
	useEffect(() => {
		released.current = undefined;
	}, [dirty, id]);
	useEffect(() => {
		if (!busy && released.current === "busy") released.current = undefined;
	}, [busy]);
	useNavigationGuard({
		blocks: (next) => {
			const modal = navigationState(next).modal;
			const retained =
				modal?.id === id
				|| (!!modal && ["archive", "return"].includes(modal.owner) && !!id && retainsModal(next, id));
			const busyExit = busy && navigationState(location).modal?.id !== modal?.id;
			return !!id && ((released.current !== "all" && dirty && !retained) || (!released.current && busyExit));
		},
		hard: busy,
		discard,
	});
	return (busyOnly = false) => {
		released.current = busyOnly ? "busy" : "all";
	};
};
