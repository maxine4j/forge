import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useLocation } from "react-router";

import { useModalNavigation } from "../navigation/controller.tsx";

export type TicketPresentation = "docked" | "centred" | "full-screen";
const desktopQuery = "(min-width: 1024px)";

export const useTicketPresentation = (): TicketPresentation => {
	const location = useLocation();
	const [desktop, setDesktop] = useState(() => matchMedia(desktopQuery).matches);
	useEffect(() => {
		const query = matchMedia(desktopQuery);
		const update = () => setDesktop(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);
	if (!desktop) return "full-screen";
	return location.pathname === "/tasks" && new URLSearchParams(location.search).get("view") !== "notifications"
		? "docked"
		: "centred";
};

// Changing presentation promotes the same DOM node; form and conversation state survive.
export const useTicketDialog = (ref: RefObject<HTMLDialogElement | null>, presentation: TicketPresentation) => {
	const opened = useRef(false);
	const opener = useRef<HTMLElement | null>(null);
	useLayoutEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (!opened.current) opener.current = document.activeElement as HTMLElement;
		const focus = dialog.contains(document.activeElement) ? (document.activeElement as HTMLElement) : null;
		const scroll = dialog.scrollTop;
		const confirmations = [...document.querySelectorAll<HTMLDialogElement>("dialog:modal")].filter(
			(element) => element !== dialog,
		);
		dialog.close();
		if (presentation === "docked") dialog.show();
		else dialog.showModal();
		for (const confirmation of confirmations) {
			confirmation.close();
			confirmation.showModal();
		}
		dialog.scrollTop = scroll;
		if (focus?.isConnected) focus.focus({ preventScroll: true });
		else if (!opened.current)
			dialog.querySelector<HTMLElement>("button:not(:disabled), [tabindex='0']")?.focus({ preventScroll: true });
		opened.current = true;
	}, [ref, presentation]);
	useLayoutEffect(() => {
		const dialog = ref.current;
		return () => {
			dialog?.close();
			if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
		};
	}, [ref]);
};

export const useDockedDismissal = (presentation: TicketPresentation, busy: boolean) => {
	const navigation = useModalNavigation();
	useEffect(() => {
		if (presentation !== "docked") return;
		const escape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || busy) return;
			if (document.querySelector("dialog:modal, [popover]:not([popover='manual']):popover-open")) return;
			event.preventDefault();
			// A confirmation may own history before its native surface has opened.
			// Resolve the current owner at action time so Escape consumes only that surface.
			navigation.dismiss();
		};
		// Nested controls consume Escape before the docked surface dismisses.
		document.addEventListener("keydown", escape);
		return () => document.removeEventListener("keydown", escape);
	}, [presentation, busy, navigation]);
};
