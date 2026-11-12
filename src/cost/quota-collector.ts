import type { ISleep } from "@forge/backend-infrastructure/sleep";
import type { WeeklyObservation } from "@forge/contracts";

import type { ICodexLimits } from "../codex/codex-usage-client.ts";
import type { IQuotaStore } from "./quota-store.ts";

export class QuotaCollector {
	private readonly abort = new AbortController();
	private loop?: Promise<void>;
	private pending?: Promise<void>;
	constructor(
		private readonly codex: ICodexLimits,
		private readonly store: IQuotaStore,
		private readonly now: () => Date,
		private readonly sleep: ISleep,
		private readonly failed: (error: unknown) => void,
	) {}
	start(): void {
		this.loop ??= this.run();
	}
	async close(): Promise<void> {
		this.abort.abort();
		await this.loop;
		await this.pending;
	}
	sample(): Promise<void> {
		if (this.abort.signal.aborted) return Promise.resolve();
		return (this.pending ??= this.collect()
			.catch((error) => this.failed(error))
			.finally(() => {
				this.pending = undefined;
			}));
	}
	private async collect(): Promise<void> {
		const limits = await this.codex.limits();
		if (this.abort.signal.aborted) return;
		const observedAt = this.now().toISOString();
		const observations: WeeklyObservation[] = [];
		for (const window of limits?.windows ?? []) {
			if (window.minutes !== 10080 || !window.resetsAt || !window.bucketId) continue;
			observations.push({
				...window,
				bucketId: window.bucketId,
				minutes: 10080,
				resetsAt: window.resetsAt,
				usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
				observedAt,
			});
		}
		if (this.store.capture)
			await this.store.capture(
				observations,
				observedAt,
				(limits?.windows.filter((window) => window.minutes === 10080).length ?? 0) === observations.length,
			);
		else for (const observation of observations) await this.store.save(observation);
	}
	private async run(): Promise<void> {
		while (!this.abort.signal.aborted) {
			try {
				await this.sample();
			} catch (error) {
				this.failed(error);
			}
			if (this.abort.signal.aborted) return;
			try {
				await this.sleep(300_000, this.abort.signal);
			} catch (error) {
				if (!this.abort.signal.aborted) this.failed(error);
			}
		}
	}
}
