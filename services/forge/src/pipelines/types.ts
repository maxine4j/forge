import type { PipelineJob } from "@forge/contracts/pipelines";

export interface Workflow {
	path: string;
	name: string;
	events: string[];
	messages: string[];
	document: Record<string, unknown>;
	jobs: PipelineJob[];
	inputs: Record<string, unknown>;
}
export interface ActExecution {
	root: string;
	source: string;
	workflow: string;
	payload: string;
}
