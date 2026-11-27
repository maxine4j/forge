import type { ISleep } from "@forge/backend-infrastructure/sleep";
import type { ModelProvider } from "@forge/contracts/model-providers";

type Status = "healthy" | "unhealthy" | "usage-limits-reached";

export function modelProviderHealth(
	request: typeof fetch,
	catalog: () => Promise<unknown>,
	quota: () => Promise<boolean>,
	sleep: ISleep,
) {
	return async (provider: ModelProvider): Promise<Status> => {
		try {
			if (provider.kind === "openai") {
				await catalog();
				return (await quota().catch(() => false)) ? "usage-limits-reached" : "healthy";
			}
			const url = new URL(provider.endpoint!);
			url.pathname += "/models";
			const deadline = new AbortController();
			const lifetime = new AbortController();
			void sleep(5000, lifetime.signal).then(
				() => deadline.abort(),
				() => {},
			);
			try {
				const response = await request(url, { signal: deadline.signal, redirect: "error" });
				if (!response.ok) {
					await response.body?.cancel();
					return response.status === 429 ? "usage-limits-reached" : "unhealthy";
				}
				const value: unknown = await response.json();
				return value
					&& typeof value === "object"
					&& "data" in value
					&& Array.isArray(value.data)
					&& value.data.every(
						(item: unknown) =>
							item && typeof item === "object" && "id" in item && typeof item.id === "string",
					)
					? "healthy"
					: "unhealthy";
			} finally {
				lifetime.abort();
			}
		} catch {
			return "unhealthy";
		}
	};
}
