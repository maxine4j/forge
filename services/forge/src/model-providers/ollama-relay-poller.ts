import { isWorkerId } from "@forge/backend-infrastructure/ollama/types";
import type { ISleep } from "@forge/backend-infrastructure/sleep";

export interface RelayProvider {
	workerId: string;
	contextWindow: number | null;
	concurrency: number | null;
}

export function readRelayInventory(input: unknown): RelayProvider[] {
	if (
		!input
		|| typeof input !== "object"
		|| !("providers" in input)
		|| !Array.isArray(input.providers)
		|| input.providers.length > 16
	)
		throw new Error("Invalid relay inventory");
	const seen = new Set<string>();
	const nullablePositive = (value: unknown): value is number | null =>
		value === null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
	return input.providers.map((entry: unknown) => {
		if (
			!entry
			|| typeof entry !== "object"
			|| !("workerId" in entry)
			|| typeof entry.workerId !== "string"
			|| !isWorkerId(entry.workerId)
			|| seen.has(entry.workerId)
			|| !("contextWindow" in entry)
			|| !nullablePositive(entry.contextWindow)
			|| !("concurrency" in entry)
			|| !nullablePositive(entry.concurrency)
		)
			throw new Error("Invalid relay inventory");
		seen.add(entry.workerId);
		return { workerId: entry.workerId, contextWindow: entry.contextWindow, concurrency: entry.concurrency };
	});
}

export async function pollOllamaRelay(
	origin: string | undefined,
	fetcher: typeof fetch,
	sleep: ISleep,
	reconcile: (providers: RelayProvider[]) => Promise<void>,
	warn: (error: unknown) => void,
	signal: AbortSignal,
): Promise<void> {
	if (!origin) return;
	while (!signal.aborted) {
		try {
			const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
			const request = async () => {
				const response = await fetcher(`${origin}/providers`, { signal: requestSignal, redirect: "error" });
				if (!response.ok) throw new Error(`Relay inventory HTTP ${response.status}`);
				return readRelayInventory(await response.json());
			};
			const inventory = await new Promise<RelayProvider[]>((resolve, reject) => {
				const aborted = () => reject(requestSignal.reason);
				if (requestSignal.aborted) return aborted();
				requestSignal.addEventListener("abort", aborted, { once: true });
				void request()
					.then(resolve, reject)
					.finally(() => requestSignal.removeEventListener("abort", aborted));
			});
			if (!signal.aborted) await reconcile(inventory);
		} catch (error) {
			if (!signal.aborted) warn(error);
		}
		if (signal.aborted) break;
		try {
			await sleep(30_000, signal);
		} catch (error) {
			if (!signal.aborted) throw error;
		}
	}
}
