import { join } from "node:path";

import type * as Files from "@forge/backend-infrastructure/file";
import { stringifyYaml } from "@forge/backend-infrastructure/yaml";
import { projectIdSchema } from "@forge/contracts";
import { branchNameSchema } from "@forge/contracts";
import type { PipelineInput } from "@forge/contracts/pipelines";

import type { IGitTransport } from "../repositories/git-transport.ts";
import type { IRepositoryClient } from "../repositories/repository-client.ts";
import type { ActExecution, Workflow } from "./types.ts";
import { parseWorkflow } from "./workflow.ts";

export interface IPipelineSnapshots {
	discover(projectId: string, branch: string): Promise<{ commit: string; workflows: Workflow[] }>;
	create(
		runId: string,
		projectId: string,
		commit: string,
		input: PipelineInput,
		workflow: Workflow,
	): Promise<ActExecution>;
	remove(runId: string): Promise<void>;
}
export class GitSnapshotClient implements IPipelineSnapshots {
	constructor(
		private readonly data: string,
		private readonly git: IGitTransport,
		private readonly files: Pick<typeof Files, "mkdir" | "writeFile" | "rm">,
		private readonly repositories: IRepositoryClient,
	) {}
	private repository(id: string): string {
		return join(this.data, "repositories", `${projectIdSchema.parse(id)}.git`);
	}
	async discover(projectId: string, branch: string): ReturnType<IPipelineSnapshots["discover"]> {
		branchNameSchema.parse(branch);
		await this.repositories.verify(projectId);
		const repository = this.repository(projectId);
		const commit = (
			await this.git.run(["-C", repository, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`])
		).trim();
		if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("Branch unavailable");
		const entries = (
			await this.git.run(["-C", repository, "ls-tree", "-r", "-z", commit, "--", ".github/workflows/"])
		).split("\0");
		const workflows: Workflow[] = [];
		for (const entry of entries) {
			const match = /^(100644|100755) blob ([a-f0-9]{40})\t(\.github\/workflows\/[^/]+\.ya?ml)$/u.exec(entry);
			if (!match) continue;
			if (workflows.length >= 100) throw new Error("Too many workflow files");
			const source = await this.git.run(["-C", repository, "cat-file", "blob", match[2]!]);
			workflows.push(parseWorkflow(source, match[3]!));
		}
		return { commit, workflows };
	}
	private root(runId: string): string {
		return join(this.data, "artifacts", projectIdSchema.parse(runId));
	}
	async create(
		runId: string,
		projectId: string,
		commit: string,
		input: PipelineInput,
		workflow: Workflow,
	): ReturnType<IPipelineSnapshots["create"]> {
		const root = this.root(runId);
		await this.files.mkdir(root, { recursive: true, mode: 0o700 });
		const source = join(root, "source");
		await this.git.run([
			"-c",
			"protocol.file.allow=always",
			"clone",
			"--no-local",
			"--no-checkout",
			"--",
			this.repository(projectId),
			source,
		]);
		await this.git.run([
			"-C",
			source,
			"-c",
			"protocol.file.allow=always",
			"fetch",
			"--no-tags",
			"--no-recurse-submodules",
			this.repository(projectId),
			commit,
		]);
		// A branch in the disposable clone lets checkout retain act's local-checkout optimization.
		await this.git.run(["-C", source, "checkout", "-B", input.branch, commit, "--"]);
		await this.git.run(["-C", source, "remote", "set-url", "origin", `https://github.com/forge/${projectId}`]);
		const payload = join(root, "event.json");
		await this.files.writeFile(
			payload,
			JSON.stringify({
				ref: `refs/heads/${input.branch}`,
				before: commit,
				after: commit,
				head_commit: { id: commit },
				repository: {
					name: projectId,
					full_name: `forge/${projectId}`,
					default_branch: "main",
					owner: { name: "forge", login: "forge" },
					clone_url: `https://github.com/forge/${projectId}`,
				},
				inputs: input.event === "workflow_dispatch" ? workflow.inputs : {},
			}),
		);
		const executionWorkflow = join(root, "workflow.yml");
		// Prefix only the display name to make every act-created resource attributable after a crash.
		await this.files.writeFile(executionWorkflow, stringifyYaml({ ...workflow.document, name: `forge-${runId}` }));
		await this.files.mkdir(join(root, "home"), { mode: 0o700 });
		return { root, source, workflow: executionWorkflow, payload };
	}
	async remove(runId: string): Promise<void> {
		for (const name of ["source", "home", "actions", "workflow.yml", "event.json"])
			await this.files.rm(join(this.root(runId), name), { recursive: true, force: true });
	}
}
