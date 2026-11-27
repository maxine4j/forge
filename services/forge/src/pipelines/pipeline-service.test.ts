import { sleep } from "@forge/backend-infrastructure/sleep";
import type { PipelineRun } from "@forge/contracts/pipelines";
import { expect, test, vi } from "vitest";

import type { IProjectService } from "../projects/project-service.ts";
import type { IPipelineProcess } from "./act-process.ts";
import { PipelineService } from "./pipeline-service.ts";
import { parseWorkflow } from "./workflow.ts";

function setup(deadlineMs = 1000) {
	const saved = new Map<string, PipelineRun>();
	const run: PipelineRun = {
		id: "123e4567-e89b-42d3-a456-426614174000",
		projectId: "123e4567-e89b-42d3-a456-426614174001",
		branch: "main",
		workflowPath: ".github/workflows/ci.yml",
		event: "push",
		commit: "a".repeat(40),
		workflowName: "CI",
		state: "pending",
		createdAt: "2026-11-12T00:00:00.000Z",
		startedAt: null,
		finishedAt: null,
		failure: null,
		jobs: [],
	};
	const store = {
		save: async (r: PipelineRun) => {
			saved.set(r.id, structuredClone(r));
		},
		get: async (id: string) => saved.get(id),
		list: async () => [...saved.values()],
		unfinished: async (afterId = "") => [...saved.values()].filter((run) => run.id > afterId),
		cleaned: vi.fn().mockResolvedValue(undefined),
	};
	const workflow = parseWorkflow(
		"on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps: [{run: echo ok}]",
		run.workflowPath,
	);
	const snapshots = {
		discover: vi.fn().mockResolvedValue({ commit: run.commit, workflows: [workflow] }),
		create: vi.fn().mockResolvedValue({
			root: "/tmp/run",
			source: "/tmp/run/source",
			workflow: "/tmp/run/workflow.yml",
			payload: "/tmp/run/event.json",
		}),
		remove: vi.fn().mockResolvedValue(undefined),
	};
	let finish!: (code: number) => void;
	const execution = new Promise<number>((resolve) => {
		finish = resolve;
	});
	const process: IPipelineProcess = {
		available: vi.fn().mockResolvedValue(undefined),
		run: vi.fn(async (_e, _i, signal) => {
			signal.addEventListener("abort", () => finish(-1));
			return execution;
		}),
		cleanup: vi.fn().mockResolvedValue(undefined),
	};
	const projects = { get: vi.fn().mockResolvedValue({ status: "ready" }) } as unknown as IProjectService;
	const service = new PipelineService(
		projects,
		store,
		snapshots,
		process,
		() => run.id,
		() => new Date(run.createdAt),
		sleep,
		deadlineMs,
	);
	return { service, saved, store, snapshots, process, finish, run };
}
const input = { branch: "main", workflowPath: ".github/workflows/ci.yml", event: "push" };
test("global conflict and timeout terminate even with no status output", async () => {
	const { service, run, saved, process } = setup(15);
	await service.submit({ username: "owner" }, run.projectId, input);
	await expect(service.submit({ username: "owner" }, run.projectId, input)).rejects.toMatchObject({
		code: "pipeline-busy",
	});
	await vi.waitFor(() => expect(saved.get(run.id)?.state).toBe("failed"));
	expect(saved.get(run.id)?.failure).toMatch(/deadline/u);
	expect(process.cleanup).toHaveBeenCalledWith(run.id);
	await service.shutdown();
});
test("missing selection rejects before launch and Docker unavailability is explicit", async () => {
	const { service, snapshots, run, process } = setup();
	snapshots.discover.mockResolvedValueOnce({ commit: run.commit, workflows: [] });
	await expect(service.submit({ username: "owner" }, run.projectId, input)).rejects.toMatchObject({
		code: "pipeline-invalid",
	});
	vi.mocked(process.available).mockRejectedValueOnce(new Error());
	await expect(service.submit({ username: "owner" }, run.projectId, input)).rejects.toMatchObject({
		code: "docker-unavailable",
	});
	expect(process.run).not.toHaveBeenCalled();
});
test("restart interrupts persisted work without replay and shutdown interrupts live work", async () => {
	const { service, saved, store, run, process } = setup();
	saved.set(run.id, run);
	await service.recover();
	expect(saved.get(run.id)?.state).toBe("interrupted");
	expect(process.run).not.toHaveBeenCalled();
	expect(store.cleaned).toHaveBeenCalledWith(run.id);
	await service.submit({ username: "owner" }, run.projectId, input);
	await vi.waitFor(() => expect(process.run).toHaveBeenCalled());
	await service.shutdown();
	expect(saved.get(run.id)?.state).toBe("interrupted");
});
test.each([0, 1, -1])("overall result follows act exit %s", async (code) => {
	const { service, saved, run, finish } = setup();
	await service.submit({ username: "owner" }, run.projectId, input);
	finish(code);
	await vi.waitFor(() => expect(saved.get(run.id)?.state).toBe(code === 0 ? "succeeded" : "failed"));
	await service.shutdown();
});
