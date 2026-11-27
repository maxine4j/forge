import { fileURLToPath } from "node:url";

import { readFile } from "@forge/backend-infrastructure/file";
import type { PipelineRun } from "@forge/contracts/pipelines";
import { expect, test } from "vitest";

import { ActLines, applyStatus } from "./status-parser.ts";
import { parseWorkflow } from "./workflow.ts";

test("parses captured bundled-release records, retaining continued failure in a successful job", async () => {
	const run = fixtureRun();
	run.jobs = parseWorkflow(
		"on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - {name: Source, run: echo source}\n      - {name: Docker, run: docker version}\n      - {name: Continued failure, run: exit 1, continue-on-error: true}\n      - {name: Last, run: echo last}",
		run.workflowPath,
	).jobs;
	const records = await readFile(fileURLToPath(new URL("./fixtures/act-v0.2.97.jsonl", import.meta.url)));
	for (const line of records!.trim().split("\n")) applyStatus(run, line, run.createdAt);
	expect(run.jobs[0]?.state).toBe("succeeded");
	expect(run.jobs[0]?.steps.map((step) => step.state)).toEqual(["succeeded", "succeeded", "failed", "succeeded"]);
});

export const fixtureRun = (): PipelineRun => ({
	id: "123e4567-e89b-42d3-a456-426614174000",
	projectId: "123e4567-e89b-42d3-a456-426614174001",
	commit: "a".repeat(40),
	branch: "main",
	workflowPath: ".github/workflows/ci.yml",
	event: "push",
	workflowName: "CI",
	state: "running",
	createdAt: "2026-11-12T00:00:00.000Z",
	startedAt: null,
	finishedAt: null,
	failure: null,
	jobs: parseWorkflow(
		`on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy: {matrix: {node: [22, 24]}}\n    steps:\n      - {id: first, name: Same, run: echo a}\n      - {id: second, name: Same, run: echo b}\n      - {id: skipped, run: echo skip}`,
		".github/workflows/ci.yml",
	).jobs,
});
test("release fields distinguish matrix, phase and step IDs, retaining continued failures", () => {
	const run = fixtureRun();
	const at = run.createdAt;
	const record = (value: object) =>
		applyStatus(run, JSON.stringify({ jobID: "test", job: "Tests", matrix: { node: 22 }, ...value }), at);
	record({ stepID: ["first"], stage: "Pre", stepResult: "success" });
	record({ stepID: ["first"], stage: "Main", msg: "⭐ Run Main Same" });
	record({ stepID: ["first"], stage: "Main", stepResult: "failure" });
	record({ stepID: ["second", "nested"], stage: "Main", stepResult: "failure" });
	record({ stepID: ["second"], stage: "Main", stepResult: "success" });
	record({ jobResult: "success" });
	expect(run.jobs[0]?.state).toBe("succeeded");
	expect(run.jobs[0]?.steps.map((s) => [s.id, s.phase, s.state])).toEqual([
		["first", "Main", "failed"],
		["second", "Main", "succeeded"],
		["skipped", "Main", "skipped"],
		["first", "Pre", "succeeded"],
	]);
	expect(run.jobs[1]?.state).toBe("pending");
	expect(record({ raw_output: true, jobResult: "failure" })).toBe(false);
	expect(applyStatus(run, '{"jobID":', at)).toBe(false);
});
test("bounded framing survives malformed, oversized and truncated records and split UTF-8", () => {
	const lines: string[] = [];
	const stream = new ActLines((line) => lines.push(line), 20);
	stream.push(Buffer.from("x".repeat(30)));
	stream.push(Buffer.from('garbage\n{"ok":true}\n'));
	const emoji = Buffer.from("😀\n");
	stream.push(emoji.subarray(0, 2));
	stream.push(emoji.subarray(2));
	stream.push(Buffer.from('{"truncated":'));
	stream.end();
	expect(lines).toEqual(['{"ok":true}', "😀", '{"truncated":']);
});
