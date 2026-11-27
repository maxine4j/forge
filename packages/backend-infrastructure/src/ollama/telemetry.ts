import { Buffer } from "node:buffer";

export interface TelemetryFrame {
	type: "telemetry";
	ready: boolean;
	contextWindow: number;
	hostMemory: { total: number; free: number } | null;
	loadedModels: { count: number; size: number; sizeVram: number } | null;
	gpus: { utilization: number | null; memoryUsed: number | null; memoryTotal: number | null }[];
}

const bytes = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableBytes = (value: unknown): boolean => value === null || bytes(value);
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Parse a bounded telemetry message independently of request control frames. */
export const readTelemetry = (data: Buffer): TelemetryFrame => {
	if (data.length > 8192) throw new Error("Invalid telemetry frame");
	const value: unknown = JSON.parse(data.toString("utf8"));
	if (
		!record(value)
		|| value["type"] !== "telemetry"
		|| typeof value["ready"] !== "boolean"
		|| !bytes(value["contextWindow"])
		|| value["contextWindow"] === 0
		|| !(
			value["hostMemory"] === null
			|| (record(value["hostMemory"])
				&& bytes(value["hostMemory"]["total"])
				&& bytes(value["hostMemory"]["free"]))
		)
		|| !(
			value["loadedModels"] === null
			|| (record(value["loadedModels"])
				&& bytes(value["loadedModels"]["count"])
				&& bytes(value["loadedModels"]["size"])
				&& bytes(value["loadedModels"]["sizeVram"]))
		)
		|| !Array.isArray(value["gpus"])
		|| value["gpus"].length > 32
		|| !value["gpus"].every(
			(gpu: unknown) =>
				record(gpu)
				&& (gpu["utilization"] === null
					|| (typeof gpu["utilization"] === "number"
						&& Number.isFinite(gpu["utilization"])
						&& gpu["utilization"] >= 0
						&& gpu["utilization"] <= 100))
				&& nullableBytes(gpu["memoryUsed"])
				&& nullableBytes(gpu["memoryTotal"]),
		)
	)
		throw new Error("Invalid telemetry frame");
	// Construct a fresh object so unrecognized input cannot enter stored snapshots.
	return {
		type: "telemetry",
		ready: value["ready"],
		contextWindow: value["contextWindow"],
		hostMemory:
			value["hostMemory"] === null
				? null
				: {
						total: (value["hostMemory"] as Record<string, number>)["total"]!,
						free: (value["hostMemory"] as Record<string, number>)["free"]!,
					},
		loadedModels:
			value["loadedModels"] === null
				? null
				: {
						count: (value["loadedModels"] as Record<string, number>)["count"]!,
						size: (value["loadedModels"] as Record<string, number>)["size"]!,
						sizeVram: (value["loadedModels"] as Record<string, number>)["sizeVram"]!,
					},
		gpus: (value["gpus"] as TelemetryFrame["gpus"]).map(({ utilization, memoryUsed, memoryTotal }) => ({
			utilization,
			memoryUsed,
			memoryTotal,
		})),
	};
};
