import { Buffer } from "node:buffer";

export interface MacosTelemetry {
	chipName: string | null;
	deviceModel: string | null;
	macosVersion: string | null;
	ollamaVersion: string | null;
	batteryPercent: number | null;
	powerWatts: number | null;
	powerSource: "battery" | "ac" | null;
}

export interface TelemetryFrame {
	type: "telemetry";
	ready: boolean;
	contextWindow: number;
	concurrency?: number;
	hostMemory: { total: number; free: number } | null;
	loadedModels: { count: number; size: number; sizeVram: number } | null;
	gpus: { utilization: number | null; memoryUsed: number | null; memoryTotal: number | null }[];
	macos?: MacosTelemetry;
}

const bytes = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableBytes = (value: unknown): boolean => value === null || bytes(value);
const record = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate and allowlist macOS metadata before it crosses a service boundary. */
export const readMacosTelemetry = (value: unknown): MacosTelemetry => {
	if (!record(value)) throw new Error("Invalid macOS telemetry");
	const string = (key: string): string | null => {
		const field = value[key];
		if (field === null || (typeof field === "string" && field.length > 0 && field.length <= 256)) return field;
		throw new Error("Invalid macOS telemetry");
	};
	const number = (key: string, max: number): number | null => {
		const field = value[key];
		if (field === null || (typeof field === "number" && Number.isFinite(field) && field >= 0 && field <= max))
			return field;
		throw new Error("Invalid macOS telemetry");
	};
	const powerSource = value["powerSource"];
	if (powerSource !== null && powerSource !== "battery" && powerSource !== "ac")
		throw new Error("Invalid macOS telemetry");
	return {
		chipName: string("chipName"),
		deviceModel: string("deviceModel"),
		macosVersion: string("macosVersion"),
		ollamaVersion: string("ollamaVersion"),
		batteryPercent: number("batteryPercent", 100),
		powerWatts: number("powerWatts", Number.MAX_VALUE),
		powerSource,
	};
};

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
		|| (value["concurrency"] !== undefined && (!bytes(value["concurrency"]) || value["concurrency"] === 0))
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
		...(value["concurrency"] === undefined ? {} : { concurrency: value["concurrency"] as number }),
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
		...(value["macos"] === undefined ? {} : { macos: readMacosTelemetry(value["macos"]) }),
	};
};
