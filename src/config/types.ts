import type { CostSettings } from "../cost/types.ts";

export interface ForgeConfiguration {
	owner: string;
	origin: string;
	dataDirectory: string;
	port: number;
	importHosts: string[];
	cost: CostSettings;
}
