import { setTimeout } from "node:timers/promises";

export interface ISleep {
	(delayMs: number, signal?: AbortSignal): Promise<void>;
}
export const sleep: ISleep = async (delayMs: number, signal?: AbortSignal) => {
	await setTimeout(delayMs, undefined, { signal });
};
