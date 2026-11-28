import { readMacosTelemetry } from "@forge/backend-infrastructure/ollama/telemetry";
import { isWorkerId } from "@forge/backend-infrastructure/ollama/types";
import type { ModelProvider } from "@forge/contracts/model-providers";

export interface RelayMetrics {
	providerId: string;
	freshness: "fresh" | "stale" | "offline" | "unavailable";
	receivedAt: string | null;
	macos?: ReturnType<typeof readMacosTelemetry> & {
		gpuUtilization: number | null;
		memory: { total: number; free: number } | null;
	};
}

/** Read only snapshots belonging to the exact configured relay provider. */
export async function readRelayMetrics(
	origin: string | undefined,
	providers: ModelProvider[],
	fetcher: typeof fetch,
): Promise<RelayMetrics[]> {
	if (!origin) return [];
	const matches = providers.filter((provider) => {
		if (provider.retired || provider.kind !== "ollama" || !isWorkerId(provider.name) || !provider.endpoint)
			return false;
		return URL.parse(provider.endpoint)?.href === new URL(`${origin}/${provider.name}/openai/v1`).href;
	});
	return Promise.all(
		matches.map(async (provider): Promise<RelayMetrics> => {
			const unavailable: RelayMetrics = { providerId: provider.id, freshness: "unavailable", receivedAt: null };
			try {
				const signal = AbortSignal.timeout(5_000);
				const request = async () => {
					const response = await fetcher(`${origin}/${provider.name}/metrics`, { signal, redirect: "error" });
					if (!response.ok) throw new Error("Relay metrics unavailable");
					return response.json() as Promise<unknown>;
				};
				const value = await new Promise<unknown>((resolve, reject) => {
					const abort = () => reject(signal.reason);
					signal.addEventListener("abort", abort, { once: true });
					void request()
						.then(resolve, reject)
						.finally(() => signal.removeEventListener("abort", abort));
				});
				if (!value || typeof value !== "object") throw new Error("Invalid metrics");
				const row = value as Record<string, unknown>;
				if (
					row["workerId"] !== provider.name
					|| !["fresh", "stale", "offline"].includes(String(row["freshness"]))
					|| typeof row["receivedAt"] !== "string"
					|| !Number.isFinite(Date.parse(row["receivedAt"]))
				)
					throw new Error("Invalid metrics");
				const result: RelayMetrics = {
					providerId: provider.id,
					freshness: row["freshness"] as RelayMetrics["freshness"],
					receivedAt: row["receivedAt"],
				};
				if (row["macos"] !== undefined) {
					const macos = readMacosTelemetry(row["macos"]);
					const gpus = row["gpus"];
					if (!Array.isArray(gpus) || gpus.length > 32) throw new Error("Invalid GPUs");
					const gpu = gpus[0]?.utilization ?? null;
					if (gpu !== null && (typeof gpu !== "number" || !Number.isFinite(gpu) || gpu < 0 || gpu > 100))
						throw new Error("Invalid GPU");
					const host = row["hostMemory"];
					let memory: { total: number; free: number } | null = null;
					if (
						host
						&& typeof host === "object"
						&& "total" in host
						&& "free" in host
						&& typeof host.total === "number"
						&& typeof host.free === "number"
						&& Number.isSafeInteger(host.total)
						&& Number.isSafeInteger(host.free)
						&& host.total > 0
						&& host.free >= 0
						&& host.free <= host.total
					)
						memory = { total: host.total, free: host.free };
					result.macos = { ...macos, gpuUtilization: gpu, memory };
				}
				return result;
			} catch {
				return unavailable;
			}
		}),
	);
}
