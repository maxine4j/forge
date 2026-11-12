import type { PipelineJob, PipelineRun } from "@forge/contracts/pipelines";
import { z } from "zod";

import { matrixKey } from "./workflow.ts";

const recordSchema = z.object({
	jobID: z.string(),
	job: z.string().optional(),
	matrix: z.record(z.string(), z.unknown()).nullable().optional(),
	stepID: z.array(z.string()).optional(),
	stage: z.string().optional(),
	stepResult: z.string().optional(),
	jobResult: z.string().optional(),
	msg: z.string().optional(),
	raw_output: z.boolean().optional(),
});
const outcome = (value: string | undefined) =>
	value === "success" ? "succeeded" : value === "failure" ? "failed" : value === "skipped" ? "skipped" : undefined;
/** v0.2.97 logger.go / step.go / job_executor.go. Raw workflow output never drives states. */
export function applyStatus(run: PipelineRun, line: string, at: string): boolean {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return false;
	}
	const parsed = recordSchema.safeParse(raw);
	if (!parsed.success || parsed.data.raw_output) return false;
	const record = parsed.data;
	const matrix = record.matrix ?? {};
	let job = run.jobs.find((job) => job.id === record.jobID && matrixKey(job.matrix) === matrixKey(matrix));
	if (!job) {
		const template = run.jobs.find((job) => job.id === record.jobID);
		if (!template || run.jobs.length >= 256) return false;
		job = structuredClone(template);
		job.matrix = matrix;
		job.state = "pending";
		job.startedAt = null;
		job.finishedAt = null;
		job.steps = job.steps
			.filter((step) => step.phase === "Main")
			.map((step) => ({ ...step, state: "pending", startedAt: null, finishedAt: null }));
		run.jobs.push(job);
	}
	if (record.job) job.name = record.job.replace(`forge-${run.id}/`, "");
	if (job.state === "pending") {
		job.state = "running";
		job.startedAt = at;
	}
	const jobState = outcome(record.jobResult);
	if (jobState) {
		job.state = jobState;
		job.finishedAt = at;
		for (const step of job.steps) {
			if (step.state === "pending") {
				step.state = "skipped";
				step.finishedAt = at;
			} else if (step.state === "running") {
				step.state = "interrupted";
				step.finishedAt = at;
			}
		}
	}
	// Nested composite IDs describe internal action steps; their parent outcome is authoritative.
	if (record.stepID?.length === 1) {
		const phase = record.stage ?? "Main";
		const stepId = record.stepID[0]!;
		let step = job.steps.find((step) => step.id === stepId && step.phase === phase);
		if (!step && ["Pre", "Post"].includes(phase)) {
			const declared = job.steps.find((step) => step.id === stepId && step.phase === "Main");
			if (declared) {
				step = { ...declared, phase, state: "pending", startedAt: null, finishedAt: null };
				job.steps.push(step);
			}
		}
		if (step) {
			const next = outcome(record.stepResult);
			if (step.state !== "failed") step.state = next ?? "running";
			step.startedAt ??= at;
			if (next) step.finishedAt = at;
		}
	}
	return true;
}
export function settleSteps(job: PipelineJob, state: "skipped" | "interrupted" | "cancelled", at: string): void {
	for (const step of job.steps)
		if (["pending", "running"].includes(step.state)) {
			step.state = state;
			step.finishedAt = at;
		}
}
/** Byte bounded line framing; oversize records are discarded through the newline. */
export class ActLines {
	private buffer = Buffer.alloc(0);
	private discarding = false;
	constructor(
		private readonly line: (line: string) => void,
		private readonly limit = 64 * 1024,
	) {}
	push(chunk: Buffer): void {
		let offset = 0;
		while (offset < chunk.length) {
			const end = chunk.indexOf(10, offset);
			const part = chunk.subarray(offset, end < 0 ? chunk.length : end);
			if (!this.discarding) {
				if (this.buffer.length + part.length > this.limit) {
					this.buffer = Buffer.alloc(0);
					this.discarding = true;
				} else this.buffer = Buffer.concat([this.buffer, part]);
			}
			if (end < 0) break;
			if (!this.discarding) this.line(this.buffer.toString("utf8"));
			this.buffer = Buffer.alloc(0);
			this.discarding = false;
			offset = end + 1;
		}
	}
	end(): void {
		if (!this.discarding && this.buffer.length) this.line(this.buffer.toString("utf8"));
		this.buffer = Buffer.alloc(0);
	}
}
