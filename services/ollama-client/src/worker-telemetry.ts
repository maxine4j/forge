import type { TelemetryFrame } from "@forge/backend-infrastructure/ollama/telemetry";

const isBytes = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const loadedModelMemory = (value: unknown): TelemetryFrame["loadedModels"] => {
	if (typeof value !== "object" || !value || !("models" in value) || !Array.isArray(value.models)) return null;
	let size = 0;
	let sizeVram = 0;
	for (const model of value.models as unknown[]) {
		if (
			typeof model !== "object"
			|| !model
			|| !("size" in model)
			|| !isBytes(model.size)
			|| !("size_vram" in model)
			|| !isBytes(model.size_vram)
		)
			return null;
		size += model.size;
		sizeVram += model.size_vram;
	}
	return isBytes(size) && isBytes(sizeVram) ? { count: value.models.length, size, sizeVram } : null;
};

export const parseNvidiaMetrics = (output: string): TelemetryFrame["gpus"] => {
	const number = (field: string | undefined): number | null =>
		field && /^[0-9]+$/u.test(field) && isBytes(Number(field)) ? Number(field) : null;
	const mib = (field: string | undefined): number | null => {
		const value = number(field);
		return value !== null && isBytes(value * 1024 ** 2) ? value * 1024 ** 2 : null;
	};
	return output
		.trim()
		.split("\n")
		.slice(0, 32)
		.flatMap((line) => {
			const [usage, used, total] = line.split(",").map((field) => field.trim());
			const percent = number(usage);
			const utilization = percent !== null && percent <= 100 ? percent : null;
			const memoryUsed = mib(used);
			const memoryTotal = mib(total);
			return utilization === null && memoryUsed === null && memoryTotal === null
				? []
				: [{ utilization, memoryUsed, memoryTotal }];
		});
};

export const collectTelemetry = async (
	contextWindow: number,
	sources: {
		hasLocalModel(signal: AbortSignal): Promise<boolean>;
		loadedModels(signal: AbortSignal): Promise<TelemetryFrame["loadedModels"]>;
		hostMemory(): TelemetryFrame["hostMemory"];
		gpus(signal: AbortSignal): Promise<TelemetryFrame["gpus"]>;
	},
	lifetime: AbortSignal,
): Promise<TelemetryFrame> => {
	const signal = AbortSignal.any([lifetime, AbortSignal.timeout(2_000)]);
	const [ready, loadedModels, gpus] = await Promise.all([
		sources.hasLocalModel(signal).catch(() => false),
		sources.loadedModels(signal).catch(() => null),
		sources.gpus(signal).catch(() => []),
	]);
	return { type: "telemetry", ready, contextWindow, hostMemory: sources.hostMemory(), loadedModels, gpus };
};
