export interface KeyboardViewport {
	height: number;
	top: number;
	left: number;
	width: number;
	scale: number;
}

export class KeyboardDetector {
	private baseline = 0;
	private width = 0;

	measure(viewport: KeyboardViewport, focused: boolean, touch: boolean, rotated = false) {
		if (Math.abs(viewport.scale - 1) > 0.01) return false;
		// Orientation events can precede resized dimensions. Rebase again when the
		// width settles; a docked keyboard changes height, not viewport width.
		if (rotated || Math.abs(viewport.width - this.width) > 1) {
			this.baseline = 0;
		}
		this.width = viewport.width;
		if (!this.baseline || viewport.height > this.baseline) this.baseline = viewport.height;
		const reduction = this.baseline - viewport.height;
		const reduced = reduction >= 120 && reduction >= this.baseline * 0.2;
		// Do not replace the closed baseline on blur while the keyboard is dismissing.
		if (!focused && !reduced) this.baseline = viewport.height;
		return focused && touch && reduced;
	}
}

export const controlInput = (data: string) =>
	/^[a-z]$/i.test(data) ? String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64) : data;

export const arrowInput = (direction: "A" | "B" | "C" | "D", application: boolean) =>
	`\x1b${application ? "O" : "["}${direction}`;
