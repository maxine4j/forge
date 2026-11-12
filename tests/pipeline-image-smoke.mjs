import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";

/** Real bundled act and production adapters, running in the smoke's private daemon. */
export async function pipelineSmoke({ docker, name, request, execute, headers, nested }) {
	assert.match(docker("exec", name, "act", "--version"), /0\.2\.97/u);
	const response = request("/api/projects", {
		method: "POST",
		headers,
		body: JSON.stringify({ name: "Pipeline smoke" }),
	});
	assert.equal(response.status, 201);
	const project = JSON.parse(response.body);
	const base = `/api/projects/${project.id}`;
	const yaml = (steps) =>
		`name: Smoke\non: [push, workflow_dispatch]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;
	const seed = (content) =>
		execute(`
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from '@forge/backend-infrastructure/file';
const dir='/tmp/forge-pipeline-seed';await mkdir(dir+'/.github/workflows',{recursive:true});
const git=(args)=>execFileSync('git',['-C',dir,...args],{encoding:'utf8'}).trim();git(['init','--initial-branch=main']);
await writeFile(dir+'/.github/workflows/ci.yml',${JSON.stringify(content)});
await writeFile(dir+'/source.txt','snapshot');
await writeFile(dir+'/.actrc',${JSON.stringify("--platform ubuntu-latest=-self-hosted\n")});
await writeFile(dir+'/.env',${JSON.stringify("MUST_NOT_LOAD=bad\n")});
await writeFile(dir+'/.secrets',${JSON.stringify("MUST_NOT_LOAD=bad\n")});
git(['add','.']);git(['commit','--allow-empty','-m','pipeline']);
execFileSync('git',['--git-dir','/data/repositories/${project.id}.git','fetch',dir,'+main:main']);
console.log(git(['rev-parse','HEAD']));`);
	const waitRun = async (id, predicate, timeout = 300000) => {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const run = JSON.parse(request(`${base}/pipeline-runs/${id}`, { headers }).body);
			if (predicate(run)) return run;
			await pause(500);
		}
		throw new Error(`Pipeline ${id} did not settle`);
	};
	const submit = async () => {
		for (let attempt = 0; ; attempt++) {
			const result = request(`${base}/pipeline-runs`, {
				method: "POST",
				headers,
				body: JSON.stringify({ branch: "main", workflowPath: ".github/workflows/ci.yml", event: "push" }),
			});
			if (result.status === 409 && attempt < 100) {
				await pause(200);
				continue;
			}
			assert.equal(result.status, 202, result.body);
			return JSON.parse(result.body);
		}
	};
	const terminal = (run) => !["pending", "running"].includes(run.state);
	const head = seed(
		yaml(
			'      - name: Source\n        run: test "$(cat source.txt)" = snapshot && test -z "$MUST_NOT_LOAD"\n      - name: Docker\n        run: docker version && docker run --rm busybox:1.37.0 echo internal-daemon\n      - name: Continued failure\n        continue-on-error: true\n        run: exit 1\n      - name: Last\n        run: echo complete',
		),
	);
	const success = await submit();
	const completed = await waitRun(success.id, terminal);
	assert.equal(completed.state, "succeeded", JSON.stringify(completed));
	assert.equal(completed.commit, head);
	assert.deepEqual(
		completed.jobs[0].steps.filter((s) => s.phase === "Main").map((s) => s.state),
		["succeeded", "succeeded", "failed", "succeeded"],
	);
	seed(yaml("      - name: Failure\n        run: exit 1\n      - name: Skipped\n        run: echo should-not-run"));
	const failed = await waitRun((await submit()).id, terminal);
	assert.equal(failed.state, "failed");
	assert.equal(failed.jobs[0].steps[0].state, "failed");
	assert.equal(failed.jobs[0].steps[1].state, "skipped");
	// Use a small job container for cancellation probes; they test lifecycle, not runner tooling.
	nested("pull", "node:24.22.0-trixie-slim");
	seed(
		yaml("      - name: Wait\n        run: sleep 300").replace(
			"runs-on: ubuntu-latest",
			"runs-on: ubuntu-latest\n    container: node:24.22.0-trixie-slim\n    defaults:\n      run:\n        shell: sh",
		),
	);
	// Short injected deadline, with actual service/storage/Git/act/process-group cleanup.
	const deadlineRun = JSON.parse(
		execute(`
import {randomUUID} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import * as files from '@forge/backend-infrastructure/file';
import {sleep} from '@forge/backend-infrastructure/sleep';
import {SqliteDatabase} from '/app/dist/database/sqlite-database.js';
import {PipelineStore} from '/app/dist/pipelines/pipeline-store.js';
import {PipelineService} from '/app/dist/pipelines/pipeline-service.js';
import {GitSnapshotClient} from '/app/dist/pipelines/git-snapshot-client.js';
import {ActProcess} from '/app/dist/pipelines/act-process.js';
import {DockerCommand} from '/app/dist/docker/docker-command.js';
import {GitTransport} from '/app/dist/repositories/git-transport.js';
import {RepositoryClient} from '/app/dist/repositories/repository-client.js';
const db=new SqliteDatabase('/data/forge.sqlite',(url,path)=>new Worker(url,{workerData:{path},execArgv:[]}));await db.initialize();const store=new PipelineStore(db);const git=new GitTransport(sleep);const docker=new DockerCommand(sleep);
const service=new PipelineService({get:async()=>({status:'ready'})},store,new GitSnapshotClient('/data',git,files,new RepositoryClient('/data',[],files,git)),new ActProcess(docker,files,sleep,process.env.PATH),randomUUID,()=>new Date(),sleep,15000);
const run=await service.submit({username:'owner'},'${project.id}',{branch:'main',workflowPath:'.github/workflows/ci.yml',event:'push'});
let result;do{await sleep(100);result=await store.get(run.id);}while(['pending','running'].includes(result.state));
await service.shutdown();await git.close();await docker.close();await db.close();console.log(JSON.stringify(result));`),
	);
	assert.equal(deadlineRun.state, "failed");
	assert.match(deadlineRun.failure, /deadline/u);
	assert.equal(nested("ps", "-aq"), "");
	const interrupted = await submit();
	await waitRun(interrupted.id, (run) => run.jobs.some((job) => job.steps.some((step) => step.state === "running")));
	docker(
		"exec",
		name,
		"pkill",
		"-KILL",
		"-f",
		"^(/usr/local/bin/)?node (/app/)?dist/main.js --container-git-config$",
	);
	for (let i = 0; i < 100; i++) {
		if (docker("inspect", "--format", "{{.State.Running}}", name) === "false") break;
		await pause(100);
	}
	docker("start", name);
	for (let i = 0; i < 100; i++) {
		try {
			if (request("/health").status === 200) break;
		} catch {}
		await pause(200);
	}
	const recovered = await waitRun(interrupted.id, terminal);
	assert.equal(recovered.state, "interrupted");
	assert.equal(nested("ps", "-aq"), "");
	return { successId: success.id, projectId: project.id };
}
