export interface ILifecycle {
	register(handler: () => Promise<void>): void;
	shutdown(): Promise<void>;
	isOpen(): boolean;
}

/** Reverse acquisition order keeps dependent resources alive during cleanup. */
export class Lifecycle implements ILifecycle {
	private readonly handlers: (() => Promise<void>)[] = [];
	private stopping: Promise<void> | undefined;
	register(handler: () => Promise<void>): void {
		if (this.stopping) throw new Error("Application is stopping");
		this.handlers.push(handler);
	}
	isOpen(): boolean {
		return !this.stopping;
	}
	shutdown(): Promise<void> {
		this.stopping ??= Promise.resolve().then(async () => {
			const errors: unknown[] = [];
			for (const handler of this.handlers.reverse()) {
				try {
					await handler();
				} catch (error) {
					errors.push(error);
				}
			}
			if (errors.length) throw new AggregateError(errors, "Cleanup failed");
		});
		return this.stopping;
	}
}
