import { createLogger } from "@forge/backend-infrastructure/logger";
import { z } from "zod";

import type { AccountNotification } from "../accounts/types.ts";
import type { AccountLimits, TokenCounts, UsageScope, UsageSnapshot, UsageTurn } from "../cost/types.ts";

export interface ICodexUsageConnection {
	initialize(): Promise<void>;
	request(method: string, params: unknown): Promise<unknown>;
	subscribe(listener: AccountNotification): () => void;
}

export interface ICodexUsageTracker {
	track(threadId: string, scope: UsageScope, model?: string): void;
}

export interface ICodexLimits {
	limits(): Promise<AccountLimits | undefined>;
}

const count = z.int().nonnegative();
const timestamp = count.max(253402300799);
const breakdown = z
	.object({ inputTokens: count, cachedInputTokens: count, outputTokens: count })
	.refine((value) => value.cachedInputTokens <= value.inputTokens);
const usage = z.object({
	threadId: z.string(),
	turnId: z.string(),
	tokenUsage: z.object({ total: breakdown, last: breakdown }),
});
const turnEvent = z.object({
	threadId: z.string(),
	turn: z.object({
		id: z.string(),
		startedAt: timestamp.nullish(),
		completedAt: timestamp.nullish(),
		durationMs: count.max(253402300799000).nullish(),
	}),
});
const windowSchema = z
	.object({ usedPercent: count, windowDurationMins: count.positive().nullish(), resetsAt: timestamp.nullish() })
	.nullish();
const bucketSchema = z.object({
	limitId: z.string().nullish(),
	limitName: z.string().nullish(),
	planType: z.string().nullish(),
	primary: windowSchema,
	secondary: windowSchema,
});
const limitsSchema = z.object({
	rateLimits: bucketSchema,
	rateLimitsByLimitId: z.record(z.string(), bucketSchema).nullish(),
});

interface TrackedTurn {
	data: UsageSnapshot;
	id?: string;
	previousId?: string;
	baseline?: TokenCounts;
}

export class CodexUsageClient implements ICodexUsageTracker, ICodexLimits {
	private readonly log = createLogger(CodexUsageClient.name);
	private readonly turns = new Map<string, TrackedTurn>();
	private readonly unsubscribe: () => void;
	private writes = Promise.resolve();

	constructor(
		private readonly connection: ICodexUsageConnection,
		private readonly save: (turn: UsageTurn) => Promise<void>,
		private readonly now: () => Date,
		private readonly monthlyAud: number,
	) {
		this.unsubscribe = connection.subscribe((method, params) => this.notification(method, params));
	}
	track(threadId: string, scope: UsageScope, model?: string): void {
		const previousId = this.turns.get(threadId)?.id;
		this.turns.set(threadId, {
			previousId,
			data: { ...scope, threadId, startedAt: this.now().toISOString(), monthlyAud: this.monthlyAud, model },
		});
	}

	async limits(): Promise<AccountLimits | undefined> {
		try {
			await this.connection.initialize();
			const result = limitsSchema.parse(await this.connection.request("account/rateLimits/read", null));
			const buckets = Object.entries(result.rateLimitsByLimitId ?? {});
			if (!buckets.length) buckets.push([result.rateLimits.limitId ?? "codex", result.rateLimits]);
			const plan = result.rateLimits.planType ?? buckets.find(([key]) => key === "codex")?.[1].planType;
			return {
				...(plan ? { plan } : {}),
				windows: buckets.flatMap(([key, bucket]) =>
					[bucket.primary, bucket.secondary].flatMap((window) =>
						window
							? [
									{
										bucketId: key,
										bucket: bucket.limitName ?? bucket.limitId ?? key,
										usedPercent: window.usedPercent,
										...(window.windowDurationMins ? { minutes: window.windowDurationMins } : {}),
										...(window.resetsAt == null
											? {}
											: { resetsAt: new Date(window.resetsAt * 1000).toISOString() }),
									},
								]
							: [],
					),
				),
			};
		} catch {
			return undefined;
		}
	}

	async close(): Promise<void> {
		this.unsubscribe();
		await this.writes;
	}

	private notification(method: string, params: unknown): void {
		switch (method) {
			case "thread/tokenUsage/updated": {
				const event = usage.safeParse(params);
				if (event.success) this.recordTokens(event.data);
				break;
			}
			case "turn/started":
			case "turn/completed": {
				const event = turnEvent.safeParse(params);
				if (!event.success) return;
				const { threadId, turn } = event.data;
				const tracked = this.match(threadId, turn.id);
				if (!tracked) return;
				if (turn.startedAt != null) tracked.data.startedAt = new Date(turn.startedAt * 1000).toISOString();
				if (method === "turn/completed") {
					tracked.data.durationMs =
						turn.durationMs
						?? (turn.startedAt != null && turn.completedAt != null
							? Math.max(0, turn.completedAt - turn.startedAt) * 1000
							: undefined);
					this.persist(tracked.data, turn.id);
				}
				break;
			}
			case "model/rerouted": {
				const event = z.object({ threadId: z.string(), turnId: z.string() }).safeParse(params);
				if (!event.success) return;
				const tracked = this.match(event.data.threadId, event.data.turnId);
				if (tracked?.data.model) {
					delete tracked.data.model;
					if (tracked.baseline) this.persist(tracked.data, event.data.turnId);
				}
				break;
			}
			case "connection/lost":
				this.turns.clear();
		}
	}

	private match(threadId: string, turnId: string): TrackedTurn | undefined {
		const tracked = this.turns.get(threadId);
		if (!tracked || tracked.previousId === turnId || (tracked.id && tracked.id !== turnId)) return undefined;
		tracked.id = turnId;
		return tracked;
	}

	private recordTokens({ threadId, turnId, tokenUsage: { total, last } }: z.infer<typeof usage>): void {
		const tracked = this.match(threadId, turnId);
		if (!tracked) return;
		if (!tracked.baseline) {
			if (
				last.inputTokens > total.inputTokens
				|| last.cachedInputTokens > total.cachedInputTokens
				|| last.outputTokens > total.outputTokens
			)
				return;
			tracked.baseline = {
				input: total.inputTokens - last.inputTokens,
				cached: total.cachedInputTokens - last.cachedInputTokens,
				output: total.outputTokens - last.outputTokens,
			};
		}
		const input = total.inputTokens - tracked.baseline.input;
		const cached = total.cachedInputTokens - tracked.baseline.cached;
		const output = total.outputTokens - tracked.baseline.output;
		const data = tracked.data;
		if (input < (data.input ?? 0) || cached < (data.cached ?? 0) || output < (data.output ?? 0) || cached > input)
			return;
		if (data.input === input && data.cached === cached && data.output === output) return;
		Object.assign(data, { input, cached, output });
		this.persist(data, turnId);
	}

	private persist(data: UsageSnapshot, turnId: string): void {
		const snapshot = { ...data, turnId };
		this.writes = this.writes
			.then(() => this.save(snapshot))
			.catch((err: unknown) => {
				this.log.error({ err }, "Could not persist Codex usage");
			});
	}
}
