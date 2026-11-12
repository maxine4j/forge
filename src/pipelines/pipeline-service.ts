import { createLogger } from "@forge/backend-infrastructure/logger";
import type { ISleep } from "@forge/backend-infrastructure/sleep";
import {
	pipelineInputSchema,
	type PipelineInput,
	type PipelineRun,
	type PipelineDiscovery,
	type PipelineRunSummary,
} from "@forge/contracts/pipelines";

import type { Actor } from "../auth/types.ts";
import { ProjectUnavailableError } from "../projects/errors.ts";
import type { IProjectService } from "../projects/project-service.ts";
import type { IPipelineProcess } from "./act-process.ts";
import { PipelineError } from "./errors.ts";
import type { IPipelineSnapshots } from "./git-snapshot-client.ts";
import type { IPipelineStore } from "./pipeline-store.ts";
import { applyStatus, settleSteps } from "./status-parser.ts";
import type { Workflow } from "./types.ts";

export interface IPipelineService {
	discover(actor: Actor, projectId: string, branch: string): Promise<PipelineDiscovery>;
	submit(actor: Actor, projectId: string, input: PipelineInput): Promise<PipelineRun>;
	history(actor: Actor, projectId: string, offset: number): Promise<{ runs: PipelineRunSummary[]; hasMore: boolean }>;
	get(actor: Actor, projectId: string, runId: string): Promise<PipelineRun>;
}
export class PipelineService implements IPipelineService {
	private active: { abort: AbortController; done: Promise<void> } | undefined;
	private submitting = false;
	private closing = false;
	private submission: Promise<void> | undefined;
	private readonly log = createLogger(PipelineService.name);
	constructor(
		private readonly projects: Pick<IProjectService, "get">,
		private readonly store: IPipelineStore,
		private readonly snapshots: IPipelineSnapshots,
		private readonly process: IPipelineProcess,
		private readonly id: () => string,
		private readonly now: () => Date,
		private readonly sleep: ISleep,
		private readonly deadlineMs = 60 * 60 * 1000,
	) {}
	private async authorize(actor: Actor, projectId: string): Promise<void> {
		if ((await this.projects.get(actor, projectId)).status !== "ready") throw new ProjectUnavailableError();
	}
	async discover(actor: Actor, projectId: string, branch: string): Promise<PipelineDiscovery> {
		await this.authorize(actor, projectId);
		try {
			const { commit, workflows } = await this.snapshots.discover(projectId, branch);
			return {
				commit,
				workflows: workflows.map(({ path, name, events, messages }) => ({ path, name, events, messages })),
			};
		} catch {
			throw new PipelineError(
				"pipeline-invalid",
				"Branch or workflow files are unavailable. Refresh the branch selection.",
			);
		}
	}
	async submit(actor: Actor, projectId: string, value: PipelineInput): Promise<PipelineRun> {
		await this.authorize(actor, projectId);
		const parsed = pipelineInputSchema.safeParse(value);
		if (!parsed.success) throw new PipelineError("pipeline-invalid", "Select a valid branch, workflow and event.");
		if (this.submitting || this.active) throw new PipelineError("pipeline-busy");
		if (this.closing) throw new PipelineError("pipeline-unavailable");
		this.submitting = true;
		let submitted!: () => void;
		this.submission = new Promise<void>((resolve) => {
			submitted = resolve;
		});
		try {
			const input = parsed.data;
			let discovery;
			try {
				discovery = await this.snapshots.discover(projectId, input.branch);
			} catch {
				throw new PipelineError("pipeline-invalid", "Branch unavailable. Refresh the pipeline selection.");
			}
			const workflow = discovery.workflows.find((workflow) => workflow.path === input.workflowPath);
			if (!workflow || !workflow.events.includes(input.event))
				throw new PipelineError(
					"pipeline-invalid",
					"Workflow or event changed. Refresh the pipeline selection.",
				);
			const messages = workflow.messages.filter(
				(message) => input.event === "workflow_dispatch" || !message.startsWith("workflow_dispatch requires"),
			);
			if (messages.length) throw new PipelineError("pipeline-invalid", messages.join(" ").slice(0, 1000));
			try {
				await this.process.available();
			} catch {
				throw new PipelineError("docker-unavailable");
			}
			if (this.closing) throw new PipelineError("pipeline-unavailable");
			const run: PipelineRun = {
				...input,
				id: this.id(),
				projectId,
				commit: discovery.commit,
				workflowName: workflow.name,
				state: "pending",
				createdAt: this.now().toISOString(),
				startedAt: null,
				finishedAt: null,
				failure: null,
				jobs: structuredClone(workflow.jobs),
			};
			await this.store.save(run);
			const response = structuredClone(run);
			const abort = new AbortController();
			const done = this.execute(run, workflow, abort)
				.catch((err: unknown) =>
					this.log.error({ err, runId: run.id }, "Pipeline persistence or cleanup failed"),
				)
				.finally(() => {
					this.active = undefined;
				});
			this.active = { abort, done };
			return response;
		} finally {
			this.submitting = false;
			submitted();
		}
	}
	async history(actor: Actor, projectId: string, offset: number) {
		await this.authorize(actor, projectId);
		const runs = await this.store.list(projectId, offset);
		return { runs: runs.slice(0, 20).map(({ jobs: _jobs, ...summary }) => summary), hasMore: runs.length > 20 };
	}
	async get(actor: Actor, projectId: string, id: string): Promise<PipelineRun> {
		await this.authorize(actor, projectId);
		const run = await this.store.get(id);
		if (!run || run.projectId !== projectId) throw new PipelineError("pipeline-not-found");
		return run;
	}
	private async execute(run: PipelineRun, workflow: Workflow, abort: AbortController): Promise<void> {
		const timer = new AbortController();
		let timedOut = false;
		let dirty = false;
		let writing: Promise<void> | undefined;
		let writeError: unknown;
		const persist = () => {
			dirty = true;
			writing ??= (async () => {
				while (dirty) {
					dirty = false;
					await this.store.save(structuredClone(run));
				}
			})()
				.catch((error: unknown) => {
					writeError = error;
					abort.abort();
				})
				.finally(() => {
					writing = undefined;
				});
		};
		void this.sleep(this.deadlineMs, timer.signal).then(
			() => {
				timedOut = true;
				abort.abort();
			},
			() => {},
		);
		try {
			run.state = "running";
			run.startedAt = this.now().toISOString();
			await this.store.save(run);
			const execution = await this.snapshots.create(run.id, run.projectId, run.commit, run, workflow);
			const code = await this.process.run(execution, run, abort.signal, (line) => {
				if (applyStatus(run, line, this.now().toISOString())) persist();
			});
			if (writeError) throw writeError;
			run.state = code === 0 ? "succeeded" : "failed";
			if (code !== 0) run.failure = `act exited with code ${code}.`;
		} catch {
			run.state = "failed";
			run.failure = "Pipeline execution failed before completion. Check the workflow and Docker availability.";
		} finally {
			timer.abort();
			await writing;
			if (abort.signal.aborted) {
				run.state = this.closing ? "interrupted" : "failed";
				run.failure = timedOut ? "Pipeline exceeded its 60-minute deadline." : "Pipeline interrupted.";
			}
			run.finishedAt = this.now().toISOString();
			for (const job of run.jobs) {
				if (["pending", "running"].includes(job.state)) {
					job.state = run.state === "succeeded" ? "skipped" : "interrupted";
					job.finishedAt = run.finishedAt;
				}
				settleSteps(job, run.state === "succeeded" ? "skipped" : "interrupted", run.finishedAt);
			}
			await this.store.save(run);
			await this.clean(run);
		}
	}
	private async clean(run: PipelineRun): Promise<void> {
		try {
			await this.process.cleanup(run.id);
			await this.snapshots.remove(run.id);
			await this.store.cleaned(run.id);
		} catch (err) {
			this.log.warn({ err, runId: run.id }, "Pipeline cleanup deferred until restart");
		}
	}
	async recover(): Promise<void> {
		let afterId = "";
		for (;;) {
			const records = await this.store.unfinished(afterId);
			if (!records.length) break;
			for (const run of records) {
				afterId = run.id;
				if (!["pending", "running"].includes(run.state)) {
					await this.clean(run);
					continue;
				}
				run.state = "interrupted";
				run.failure = "Forge restarted; workflow was not replayed.";
				run.finishedAt ??= this.now().toISOString();
				for (const job of run.jobs) {
					if (["pending", "running"].includes(job.state)) {
						job.state = "interrupted";
						job.finishedAt = run.finishedAt;
					}
					settleSteps(job, "interrupted", run.finishedAt);
				}
				await this.store.save(run);
				await this.clean(run);
			}
		}
	}
	async shutdown(): Promise<void> {
		this.closing = true;
		await this.submission;
		this.active?.abort.abort();
		await this.active?.done;
	}
}
