import { parseYaml } from "@forge/backend-infrastructure/yaml";
import { z } from "zod";

import type { Workflow } from "./types.ts";

export const runnerImages: Record<string, string> = {
	"ubuntu-latest": "catthehacker/ubuntu@sha256:51fdb5d2f9f4c747cf3966512cd691a090792517d77a22b33b928fad231ff790",
	"ubuntu-24.04": "catthehacker/ubuntu@sha256:51fdb5d2f9f4c747cf3966512cd691a090792517d77a22b33b928fad231ff790",
	"ubuntu-22.04": "catthehacker/ubuntu@sha256:12f97d02ba92781b74668c08d9b1f2a7f891580263f118b1efd6ec644a5f3866",
	"ubuntu-20.04": "catthehacker/ubuntu@sha256:12758971effd1bb92bf7fee18fe22a9d4ce57f35ce8e2c3175ae22244d95d2cc",
};
const object = z.record(z.string(), z.unknown());
const stepSchema = z
	.object({
		id: z.string().min(1).optional(),
		name: z.string().optional(),
		run: z.string().optional(),
		uses: z.string().min(1).optional(),
	})
	.refine(
		(step) => (step.run !== undefined) !== (step.uses !== undefined),
		"Each step requires exactly one run or uses field.",
	);
const state = { state: "pending" as const, startedAt: null, finishedAt: null };
export function matrixKey(matrix: Record<string, unknown>): string {
	return JSON.stringify(Object.fromEntries(Object.entries(matrix).sort(([a], [b]) => a.localeCompare(b))));
}
export function parseWorkflow(source: string, path: string): Workflow {
	const result: Workflow = {
		path,
		name: path.split("/").at(-1)!,
		events: [],
		messages: [],
		document: {},
		jobs: [],
		inputs: {},
	};
	try {
		const doc = object.parse(parseYaml(source, path));
		result.document = doc;
		if (typeof doc["name"] === "string") result.name = doc["name"];
		const on = doc["on"];
		result.events =
			typeof on === "string"
				? [on]
				: Array.isArray(on)
					? z.array(z.string()).parse(on)
					: Object.keys(object.parse(on));
		if (!result.events.length || result.events.some((event) => !/^[a-z][a-z0-9_]{0,99}$/u.test(event)))
			throw new Error("Invalid events");
		const dispatch = object.safeParse(
			typeof on === "object" && on !== null ? (on as Record<string, unknown>)["workflow_dispatch"] : undefined,
		);
		const inputs = object.parse(dispatch.success ? (dispatch.data["inputs"] ?? {}) : {});
		for (const [key, value] of Object.entries(inputs)) {
			const input = object.parse(value);
			if (input["default"] !== undefined) result.inputs[key] = input["default"];
			else if (input["required"] === true)
				result.messages.push(`workflow_dispatch requires input '${key}' without a default.`);
		}
		for (const [id, raw] of Object.entries(object.parse(doc["jobs"]))) {
			const job = object.parse(raw);
			const labels =
				typeof job["runs-on"] === "string" ? [job["runs-on"]] : z.array(z.string()).parse(job["runs-on"]);
			if (labels.length !== 1 || !Object.hasOwn(runnerImages, labels[0]!))
				throw new Error("Unsupported runner; use ubuntu-20.04, ubuntu-22.04, ubuntu-24.04 or ubuntu-latest.");
			if (job["uses"]) throw new Error("Reusable workflow jobs are unsupported.");
			const steps = z.array(stepSchema).min(1).max(200).parse(job["steps"]);
			if (new Set(steps.map((s, i) => s.id ?? String(i))).size !== steps.length)
				throw new Error("Duplicate step IDs");
			const strategy = object.parse(job["strategy"] ?? {});
			const matrix = object.parse(strategy["matrix"] ?? {});
			const axes = Object.keys(matrix).filter((key) => !["include", "exclude"].includes(key));
			let variants: Record<string, unknown>[] = axes.length ? [{}] : [];
			for (const [key, values] of Object.entries(matrix)) {
				if (key === "include" || key === "exclude") continue;
				variants = variants.flatMap((variant) =>
					z
						.array(z.union([z.string(), z.number(), z.boolean()]))
						.parse(values)
						.map((value) => ({ ...variant, [key]: value })),
				);
				if (variants.length > 256) throw new Error("Matrix exceeds 256 jobs");
			}
			const matches = (a: Record<string, unknown>, b: Record<string, unknown>) =>
				Object.entries(b).every(([k, v]) => a[k] === v);
			const exclusions = z.array(object).parse(matrix["exclude"] ?? []);
			if (exclusions.some((excluded) => Object.keys(excluded).some((key) => !axes.includes(key))))
				throw new Error("Matrix exclude keys must name declared axes.");
			variants = variants.filter(
				(v) =>
					!z
						.array(object)
						.parse(matrix["exclude"] ?? [])
						.some((e) => matches(v, e)),
			);
			const extras: Record<string, unknown>[] = [];
			for (const included of z.array(object).parse(matrix["include"] ?? [])) {
				let merged = false;
				for (const variant of variants) {
					if (
						Object.keys(matrix)
							.filter((k) => !["include", "exclude"].includes(k))
							.every((k) => included[k] === undefined || included[k] === variant[k])
					) {
						Object.assign(variant, included);
						merged = true;
					}
				}
				if (!merged) extras.push(included);
			}
			variants.push(...extras);
			if (!variants.length) variants.push({});
			if (variants.length > 256) throw new Error("Matrix exceeds 256 jobs");
			for (const variant of variants)
				result.jobs.push({
					id,
					name: typeof job["name"] === "string" ? job["name"] : id,
					matrix: variant,
					...state,
					steps: steps.map((step, order) => ({
						id: step.id ?? String(order),
						name: (step.name ?? step.uses ?? step.run?.split("\n")[0] ?? String(order)).slice(0, 500),
						order,
						phase: "Main",
						...state,
					})),
				});
		}
		if (!result.jobs.length || result.jobs.length > 256) throw new Error("Workflow requires 1–256 jobs");
	} catch (error) {
		result.messages.push(
			error instanceof Error && !error.message.startsWith("[")
				? error.message.slice(0, 500)
				: "Invalid workflow structure or YAML.",
		);
	}
	return result;
}
