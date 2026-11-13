export type ToastVariant = "error" | "success";
export interface Toast {
	id: number;
	message: string;
	variant: ToastVariant;
	count: number;
	deadline: number;
	revision: number;
}

/** Only the visible entry owns a timer. The queue has no dependency on React or the DOM. */
export class ToastQueue {
	private entries: Toast[] = [];
	private sequence = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private listeners = new Set<() => void>();
	readonly snapshot = () => this.entries[0];
	readonly subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	readonly notify = (message: string, variant: ToastVariant = "error") => {
		if (!message) return;
		const index = this.entries.findIndex((entry) => entry.message === message);
		if (index >= 0) {
			this.entries = this.entries.map((entry, position) =>
				position === index
					? {
							...entry,
							count: entry.count + 1,
							revision: entry.revision + 1,
							deadline: position === 0 ? Date.now() + 3000 : 0,
						}
					: entry,
			);
		} else {
			this.entries.push({
				id: ++this.sequence,
				message,
				variant,
				count: 1,
				deadline: this.entries.length ? 0 : Date.now() + 3000,
				revision: 0,
			});
		}
		this.changed();
	};
	readonly dismiss = () => {
		this.entries.shift();
		if (this.entries[0]) this.entries[0] = { ...this.entries[0], deadline: Date.now() + 3000 };
		this.changed();
	};
	private changed() {
		clearTimeout(this.timer);
		const active = this.snapshot();
		if (active) this.timer = setTimeout(this.dismiss, Math.max(0, active.deadline - Date.now()));
		this.listeners.forEach((listener) => listener());
	}
	dispose() {
		clearTimeout(this.timer);
		this.entries = [];
		this.listeners.clear();
	}
}
