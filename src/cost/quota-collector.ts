import type { ISleep } from "@forge/backend-infrastructure/sleep";

import type { ICodexLimits } from "../codex/codex-usage-client.ts";
import type { IQuotaStore } from "./quota-store.ts";

export class QuotaCollector {
	private readonly abort = new AbortController();
	private loop?: Promise<void>;
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
	}
	private async run(): Promise<void> {
		while (!this.abort.signal.aborted) {
			try {
				const limits = await this.codex.limits();
				const observedAt = this.now().toISOString();
				for (const window of limits?.windows ?? []) {
					if (this.abort.signal.aborted) break;
					if (window.minutes !== 10080 || !window.resetsAt || !window.bucketId) continue;
					await this.store.save({
						...window,
						bucketId: window.bucketId,
						minutes: 10080,
						resetsAt: window.resetsAt,
						usedPercent: Math.min(100, Math.max(0, window.usedPercent)),
						observedAt,
					});
				}
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
