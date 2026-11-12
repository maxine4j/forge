import { expect, test } from "vitest";

import { parseWorkflow } from "./workflow.ts";

const path = ".github/workflows/ci.yaml";
test.each(["on: push", "on: [push, workflow_dispatch]", "on:\n  push:\n  workflow_dispatch:"])(
	"discovers event forms: %s",
	(on) => {
		const workflow = parseWorkflow(
			`${on}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n`,
			path,
		);
		expect(workflow.messages).toEqual([]);
		expect(workflow.events).toContain("push");
		expect(workflow.jobs[0]?.steps[0]?.id).toBe("0");
	},
);
test("dispatch defaults, required input validation and unsupported runners", () => {
	const workflow = parseWorkflow(
		`on:\n  workflow_dispatch:\n    inputs:\n      count: {default: 2}\n      required: {required: true}\njobs:\n  test:\n    runs-on: windows-latest\n    steps: [{run: echo ok}]`,
		path,
	);
	expect(workflow.inputs).toEqual({ count: 2 });
	expect(workflow.messages.join(" ")).toMatch(/requires input 'required'.*Unsupported runner/u);
});
test("prepopulates ordered duplicate names and distinct matrix jobs", () => {
	const workflow = parseWorkflow(
		`on: push\njobs:\n  test:\n    runs-on: ubuntu-22.04\n    strategy:\n      matrix:\n        node: [22, 24]\n        os: [a, b]\n        exclude: [{node: 22, os: b}]\n        include: [{node: 24, extra: yes}]\n    steps:\n      - {name: Same, run: echo a}\n      - {name: Same, id: second, run: echo b}`,
		path,
	);
	expect(workflow.messages).toEqual([]);
	expect(workflow.jobs.map((j) => j.matrix)).toEqual([
		{ node: 22, os: "a" },
		{ node: 24, os: "a", extra: "yes" },
		{ node: 24, os: "b", extra: "yes" },
	]);
	expect(workflow.jobs[0]?.steps.map((s) => [s.id, s.order, s.state])).toEqual([
		["0", 0, "pending"],
		["second", 1, "pending"],
	]);
});
test.each([
	"on: [",
	"on: push\non: pull_request",
	"on: push\njobs: {}",
	"on: push\njobs: {test: {runs-on: '${{ matrix.os }}', steps: [{run: ok}]}}",
])("invalid workflows remain visible with messages", (source) => {
	expect(parseWorkflow(source, path).messages.length).toBeGreaterThan(0);
});

test("include-only matrices retain separate combinations and extra includes do not merge", () => {
	const workflow = parseWorkflow(
		"on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    strategy:\n      matrix:\n        include: [{node: 22}, {node: 24}]\n    steps: [{run: echo ok}]",
		path,
	);
	expect(workflow.messages).toEqual([]);
	expect(workflow.jobs.map((job) => job.matrix)).toEqual([{ node: 22 }, { node: 24 }]);
});

test.each(["toString", "constructor", "-self-hosted", "windows-latest"])("rejects unsupported platform %s", (label) => {
	expect(
		parseWorkflow(
			`on: push\njobs:\n  test:\n    runs-on: ${label}\n    steps: [{run: echo ok}]`,
			path,
		).messages.join(" "),
	).toContain("Unsupported runner");
});
