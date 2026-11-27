import type { TelemetryFrame } from "@forge/backend-infrastructure/ollama/telemetry";
import type { ISleep } from "@forge/backend-infrastructure/sleep";

import { RelayService } from "./relay-service.ts";

export interface WorkerSlot {
	service: RelayService;
	lifetime: AbortController;
	reading: number;
	disconnectedAt?: number;
	report?: { receivedAt: number; sample: TelemetryFrame };
}

const maxNamedWorkers = 16;
const freshnessMs = 45_000;
const offlineRetentionMs = 300_000;

export class WorkerRegistry {
	private readonly live = new Map<string | undefined, WorkerSlot>();
	private readonly offline = new Map<string, WorkerSlot>();

	constructor(
		private readonly sleep: ISleep,
		private readonly now: () => number,
	) {}

	admission(id: string | undefined): 409 | 503 | undefined {
		if (this.live.has(id)) return 409;
		if (id !== undefined && this.live.size - Number(this.live.has(undefined)) >= maxNamedWorkers) return 503;
		return undefined;
	}

	connect(id: string | undefined): WorkerSlot {
		const slot = { service: new RelayService(this.sleep), lifetime: new AbortController(), reading: 0 };
		if (id !== undefined) this.offline.delete(id);
		this.live.set(id, slot);
		return slot;
	}

	disconnect(id: string | undefined, slot: WorkerSlot): void {
		this.live.delete(id);
		slot.disconnectedAt = this.now();
		slot.lifetime.abort();
		if (id === undefined) return;
		this.offline.set(id, slot);
		if (this.offline.size > maxNamedWorkers) this.offline.delete(this.offline.keys().next().value!);
	}

	get(id: string | undefined): WorkerSlot | undefined {
		if (id === undefined) return this.live.get(id);
		const offline = this.offline.get(id);
		if (offline?.disconnectedAt !== undefined && this.now() - offline.disconnectedAt >= offlineRetentionMs)
			this.offline.delete(id);
		return this.live.get(id) ?? this.offline.get(id);
	}

	report(slot: WorkerSlot, sample: TelemetryFrame): void {
		slot.report = { receivedAt: this.now(), sample };
	}

	inventory(): { workerId: string; contextWindow: number | null; concurrency: number | null }[] {
		return [...this.live.entries()]
			.flatMap(([workerId, slot]) => {
				if (workerId === undefined) return [];
				const sample =
					slot.report && this.now() - slot.report.receivedAt < freshnessMs ? slot.report.sample : undefined;
				return [
					{
						workerId,
						contextWindow: sample?.contextWindow ?? null,
						concurrency: sample ? (sample.concurrency ?? 1) : null,
					},
				];
			})
			.sort((a, b) => a.workerId.localeCompare(b.workerId));
	}

	status(slot: WorkerSlot): "offline" | "starting" | "stale" | "ready" | "unhealthy" {
		if (slot.disconnectedAt !== undefined) return "offline";
		if (!slot.report) return "starting";
		if (this.now() - slot.report.receivedAt >= freshnessMs) return "stale";
		return slot.report.sample.ready ? "ready" : "unhealthy";
	}
}
