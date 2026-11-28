import type { MacosTelemetry, TelemetryFrame } from "@forge/backend-infrastructure/ollama/telemetry";

type Runner = (command: string, args: string[], signal: AbortSignal) => Promise<string>;
const text = (value: unknown): string | null =>
	typeof value === "string" && value.trim().length > 0 && value.trim().length <= 256 ? value.trim() : null;

export const parseHardware = (output: string): { chipName: string | null; deviceModel: string | null } => {
	try {
		const item: unknown = JSON.parse(output)?.SPHardwareDataType?.[0];
		if (!item || typeof item !== "object") throw new Error("Invalid hardware");
		const hardware = item as Record<string, unknown>;
		return {
			chipName: text(hardware["chip_type"]) ?? text(hardware["cpu_type"]),
			deviceModel: text(hardware["machine_name"]) ?? text(hardware["machine_model"]),
		};
	} catch {
		return { chipName: null, deviceModel: null };
	}
};

export const parseBattery = (output: string): Pick<MacosTelemetry, "batteryPercent" | "powerSource"> => {
	const source = /Now drawing from '([^']+)'/u.exec(output)?.[1];
	const percentage = /(?:^|\s)(\d+(?:\.\d+)?)%/u.exec(output)?.[1];
	const value = percentage === undefined ? null : Number(percentage);
	return {
		batteryPercent: value !== null && value <= 100 ? value : null,
		powerSource: source === "Battery Power" ? "battery" : source === "AC Power" ? "ac" : null,
	};
};

export const parsePower = (output: string): { utilization: number | null; powerWatts: number | null } => {
	const gpu = /GPU HW active residency:\s*(\d+(?:\.\d+)?)%/iu.exec(output)?.[1];
	const power = /Combined Power \(CPU \+ GPU \+ ANE\):\s*(\d+(?:\.\d+)?)\s*mW/iu.exec(output)?.[1];
	const utilization = gpu === undefined ? null : Number(gpu);
	const watts = power === undefined ? null : Number(power) / 1000;
	return {
		utilization: utilization !== null && Number.isFinite(utilization) && utilization <= 100 ? utilization : null,
		powerWatts: watts !== null && Number.isFinite(watts) ? watts : null,
	};
};

export const createMacosCollector = (
	run: Runner,
	version: (signal: AbortSignal) => Promise<string | null>,
	powerEnabled: boolean,
) => {
	let chipName: string | null = null;
	let deviceModel: string | null = null;
	let macosVersion: string | null = null;
	return async (signal: AbortSignal): Promise<{ macos: MacosTelemetry; gpus: TelemetryFrame["gpus"] }> => {
		const [hardware, os, battery, power, ollamaVersion] = await Promise.all([
			chipName && deviceModel
				? Promise.resolve(null)
				: run("/usr/sbin/system_profiler", ["-json", "SPHardwareDataType"], signal).catch(() => null),
			macosVersion
				? Promise.resolve(null)
				: run("/usr/bin/sw_vers", ["-productVersion"], signal).catch(() => null),
			run("/usr/bin/pmset", ["-g", "batt"], signal).catch(() => ""),
			powerEnabled
				? run(
						"/usr/bin/sudo",
						["-n", "/usr/bin/powermetrics", "-n", "1", "-i", "500", "--samplers", "cpu_power,gpu_power"],
						signal,
					).catch(() => "")
				: Promise.resolve(""),
			version(signal).catch(() => null),
		]);
		if (hardware) {
			const parsed = parseHardware(hardware);
			chipName ??= parsed.chipName;
			deviceModel ??= parsed.deviceModel;
		}
		macosVersion ??= text(os);
		const reading = parsePower(power);
		return {
			macos: {
				chipName,
				deviceModel,
				macosVersion,
				ollamaVersion: text(ollamaVersion),
				...parseBattery(battery),
				powerWatts: reading.powerWatts,
			},
			gpus:
				reading.utilization === null
					? []
					: [{ utilization: reading.utilization, memoryUsed: null, memoryTotal: null }],
		};
	};
};
