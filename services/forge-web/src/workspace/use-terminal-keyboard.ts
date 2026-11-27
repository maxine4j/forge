import { useEffect, useRef, useState, type RefObject } from "react";

import { KeyboardDetector, type KeyboardViewport } from "./terminal-keyboard.ts";

export const useTerminalKeyboard = (root: RefObject<HTMLElement | null>, active: boolean) => {
	const [viewport, setViewport] = useState<KeyboardViewport>();
	const detector = useRef(new KeyboardDetector());
	useEffect(() => {
		const visual = window.visualViewport;
		const measure = (rotated = false) => {
			const value = {
				height: visual?.height ?? window.innerHeight,
				width: visual?.width ?? window.innerWidth,
				top: visual?.offsetTop ?? 0,
				left: visual?.offsetLeft ?? 0,
				scale: visual?.scale ?? 1,
			};
			const focused = active && !!root.current?.contains(document.activeElement);
			setViewport(
				detector.current.measure(value, focused, navigator.maxTouchPoints > 0, rotated) ? value : undefined,
			);
		};
		const update = () => measure();
		const rotate = () => measure(true);
		const blur = (event: FocusEvent) => {
			if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget)) return;
			update();
		};
		// Capture the keyboard-closed dimensions before terminal focus opens it.
		update();
		visual?.addEventListener("resize", update);
		visual?.addEventListener("scroll", update);
		window.addEventListener("resize", update);
		window.addEventListener("orientationchange", rotate);
		document.addEventListener("focusin", update);
		document.addEventListener("focusout", blur);
		return () => {
			visual?.removeEventListener("resize", update);
			visual?.removeEventListener("scroll", update);
			window.removeEventListener("resize", update);
			window.removeEventListener("orientationchange", rotate);
			document.removeEventListener("focusin", update);
			document.removeEventListener("focusout", blur);
		};
	}, [root, active]);
	return active ? viewport : undefined;
};
