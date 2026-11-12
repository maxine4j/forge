import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { mkdir, writeFile } from "@forge/backend-infrastructure/file";

// Tests only: inspect the real, built container through Docker, without publishing HTTP ports.
const image = process.env.FORGE_IMAGE ?? "forge:dev";
const name = `forge-smoke-${randomUUID()}`;
const volume = `${name}-data`;
const docker = (...args) =>
	execFileSync(
		"docker",
		args[0] === "exec"
			? ["exec", "--user", "agent", ...args.slice(1)]
			: args[0] === "run"
				? ["run", "--privileged", ...args.slice(1)]
				: args,
		{ encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] },
	).trim();
const execute = (code) => docker("exec", name, "node", "--input-type=module", "-e", code);
const request = (path, options = {}) =>
	JSON.parse(
		execute(
			`const r = await fetch(${JSON.stringify(`http://127.0.0.1:8080${path}`)}, ${JSON.stringify(options)}); console.log(JSON.stringify({status:r.status, type:r.headers.get('content-type'), csp:r.headers.get('content-security-policy'), cache:r.headers.get('cache-control'), body:await r.text()}));`,
		),
	);
const headers = { "x-webauth-user": "owner", origin: "https://forge.example.test", "content-type": "application/json" };
const waitFor = async (probe) => {
	const deadline = Date.now() + 30_000;
	let error;
	while (Date.now() < deadline) {
		try {
			return await probe();
		} catch (cause) {
			error = cause;
			await pause(100);
		}
	}
	throw error;
};
const env = ["-e", "FORGE_OWNER=owner", "-e", "FORGE_ORIGIN=https://forge.example.test"];
let normalLogs = "";
try {
	docker("volume", "create", volume);
	docker("run", "-d", "--name", name, "--mount", `type=volume,source=${volume},target=/data`, ...env, image);
	await waitFor(() => assert.equal(request("/health").status, 200));
	const inspect = JSON.parse(docker("inspect", name))[0];
	assert.equal(inspect.Config.User, "root");
	assert.match(
		docker("exec", name, "ps", "-eo", "uid,args"),
		/1000\s+.*node (?:\/app\/)?dist\/main\.js --container-git-config\s*$/m,
	);
	assert.equal(inspect.HostConfig.Privileged, true);
	assert.ok(!inspect.Config.Volumes || Object.keys(inspect.Config.Volumes).length === 0);
	assert.equal(docker("exec", name, "id", "-un"), "agent");
	for (const command of ["git", "gh", "python3", "go", "uv", "tini", "bash"])
		assert.ok(docker("exec", name, "/bin/bash", "-c", `command -v ${command}`));
	assert.match(docker("exec", name, "codex", "--version"), /0\.164\.0/);
	assert.equal(Object.keys(inspect.HostConfig.PortBindings ?? {}).length, 0);
	const nested = (...args) => docker("exec", name, "docker", "--host", "unix:///run/forge/docker.sock", ...args);
	await waitFor(() => assert.equal(nested("info", "--format", "{{.Driver}}"), "vfs"));
	assert.equal(nested("info", "--format", "{{.DockerRootDir}}"), "/var/lib/forge-docker");
	assert.match(nested("compose", "version", "--short"), /2\.39\.4/);
	assert.match(nested("buildx", "version"), /v0\.28\.0/);
	assert.ok(!inspect.Mounts.some((mount) => mount.Destination.includes("docker.sock")));
	assert.equal(docker("exec", name, "stat", "-c", "%G %a", "/run/forge/docker.sock"), "agent 660");
	assert.doesNotMatch(docker("exec", name, "ps", "-eo", "args"), /--host[= ]tcp:/);
	const clean = async (path) => {
		const response = request(path, { method: "POST", headers });
		assert.equal(response.status, 202);
		const id = JSON.parse(response.body).id;
		await waitFor(() => {
			const operation = JSON.parse(request(`/api/board/docker/operations/${id}`, { headers }).body);
			assert.notEqual(operation.status, "running");
			assert.equal(operation.status, "completed", JSON.stringify(operation));
			return operation;
		});
	};
	// A real BuildKit build, Compose networking, and an actual worktree-shaped bind mount.
	execute(
		"import {mkdir,writeFile} from '@forge/backend-infrastructure/file'; await mkdir('/data/worktrees/docker-smoke',{recursive:true}); await writeFile('/data/worktrees/docker-smoke/Dockerfile','FROM busybox:1.37.0\\nRUN echo built > /built\\nCMD [\"sleep\",\"300\"]\\n'); await writeFile('/data/worktrees/docker-smoke/compose.yaml','services:\\n  first:\\n    image: forge-smoke:latest\\n    volumes:\\n      - shared:/shared\\n      - /data/worktrees/docker-smoke:/source\\n  second:\\n    image: forge-smoke:latest\\n    volumes:\\n      - shared:/shared\\nvolumes:\\n  shared: {}\\n');",
	);
	nested("build", "-t", "forge-smoke:latest", "/data/worktrees/docker-smoke");
	nested("tag", "forge-smoke:latest", "forge-smoke:second");
	const compose = (...args) =>
		nested("compose", "-p", "forge-smoke", "-f", "/data/worktrees/docker-smoke/compose.yaml", ...args);
	compose("up", "-d");
	const first = compose("ps", "-q", "first");
	const second = compose("ps", "-q", "second");
	assert.equal(nested("exec", first, "cat", "/built"), "built");
	assert.match(nested("exec", first, "cat", "/source/Dockerfile"), /FROM busybox/);
	assert.match(nested("exec", first, "ping", "-c", "1", "second"), /1 packets received/);
	await waitFor(() => {
		const state = JSON.parse(request("/api/board/docker", { headers }).body);
		assert.equal(state.available, true);
		assert.equal(state.containers.length, 2);
		assert.ok(state.containers.every((container) => container.stats && container.stats.processes !== "0"));
	});
	await clean(`/api/board/docker/containers/${first}/cleanup`);
	assert.equal(nested("inspect", "--format", "{{.State.Running}}", second), "true");
	assert.ok(nested("volume", "ls", "-q").includes("forge-smoke_shared"));
	assert.ok(nested("image", "ls", "--format", "{{.Repository}}:{{.Tag}}").includes("forge-smoke:second"));
	await clean(`/api/board/docker/containers/${second}/cleanup`);
	assert.ok(!nested("image", "ls", "--format", "{{.Repository}}").includes("forge-smoke"));
	nested("volume", "create", "unused-named");
	nested("create", "--name", "stopped-smoke", "busybox:1.37.0");
	await clean("/api/board/docker/cleanup");
	assert.equal(nested("ps", "-aq"), "");
	assert.equal(nested("volume", "ls", "-q"), "");
	assert.equal(nested("image", "ls", "-aq"), "");
	assert.match(
		execute(
			"import {readFile} from '@forge/backend-infrastructure/file'; console.log(await readFile('/data/worktrees/docker-smoke/Dockerfile'));",
		),
		/FROM busybox/,
	);
	// Leave state to verify startup removes it on restart, including named volumes.
	nested("volume", "create", "restart-disposable");
	nested("run", "-d", "--name", "restart-workload", "busybox:1.37.0", "sleep", "300");
	const settings = {
		planningInstructions: "Include rollout steps.",
		implementationInstructions: "Run focused tests.",
		gitName: "Forge Test Developer",
		gitEmail: "forge@example.test",
	};
	const assertGitIdentity = () => {
		for (const user of ["agent", "root"]) {
			assert.equal(
				docker("exec", "-u", user, name, "git", "config", "--system", "--includes", "--get", "user.name"),
				settings.gitName,
			);
			assert.match(
				docker(
					"exec",
					"-u",
					user,
					"-e",
					"HOME=/tmp/forge-test-home",
					name,
					"git",
					"var",
					"GIT_COMMITTER_IDENT",
				),
				/^Forge Test Developer <forge@example\.test> /u,
			);
		}
		assert.match(
			docker("exec", "-e", "HOME=/data", name, "git", "var", "GIT_AUTHOR_IDENT"),
			/^Forge Test Developer <forge@example\.test> /u,
		);
	};
	const savedSettings = request("/api/settings", { method: "PUT", headers, body: JSON.stringify(settings) });
	assert.equal(savedSettings.status, 200);
	assert.deepEqual(JSON.parse(savedSettings.body), settings);
	assertGitIdentity();
	// Match Codex's sanitized HOME/PATH and the reported Bash login-shell command.
	execute(
		"import {mkdir,writeFile} from '@forge/backend-infrastructure/file'; await mkdir('/tmp/forge-nvm-probe'); await writeFile('/tmp/forge-nvm-probe/.nvmrc','24.22.0\\n');",
	);
	assert.equal(
		docker(
			"exec",
			"-w",
			"/tmp/forge-nvm-probe",
			"-e",
			"HOME=/data",
			"-e",
			"PATH=/usr/local/bin:/usr/bin:/bin",
			name,
			"/bin/bash",
			"-lc",
			"nvm use >/dev/null && pwd",
		),
		"/tmp/forge-nvm-probe",
	);
	assert.equal(
		docker(
			"exec",
			"-w",
			"/tmp/forge-nvm-probe",
			"-e",
			"HOME=/data",
			name,
			"/bin/bash",
			"-lc",
			"nvm use >/dev/null && node --version && nvm --version",
		),
		"v24.22.0\n0.40.8",
	);
	assert.equal(request("/").status, 403);
	const html = request("/", { headers });
	assert.equal(html.type, "text/html; charset=utf-8");
	assert.equal(html.cache, "no-store");
	assert.match(html.csp, /default-src 'self'; style-src-elem 'self' 'unsafe-inline';/u);
	assert.match(html.csp, /frame-ancestors 'none'/u);
	assert.doesNotMatch(html.csp, /unsafe-eval|script-src[^;]*unsafe-inline/u);
	const asset = html.body.match(/src="(\/assets\/[^" ]+\.js)"/u)?.[1];
	assert.ok(asset);
	assert.equal(request(asset, { headers }).cache, "private, max-age=31536000, immutable");
	assert.equal(request("/api/missing", { headers }).status, 404);
	assert.equal(
		request("/api/projects", {
			method: "POST",
			headers: { ...headers, origin: "https://other.test" },
			body: '{"name":"Denied"}',
		}).status,
		403,
	);
	const created = request("/api/projects", { method: "POST", headers, body: '{"name":"Persistent project"}' });
	assert.equal(created.status, 201);
	const project = JSON.parse(created.body);
	assert.equal(project.status, "ready");
	const chatResponse = request(`/api/projects/${project.id}/agents`, {
		method: "POST",
		headers,
		body: JSON.stringify({ title: "Persistent chat" }),
	});
	assert.equal(chatResponse.status, 201);
	const chat = JSON.parse(chatResponse.body);
	assert.equal(chat.thread.status, "idle");
	assert.deepEqual(chat.items, []);
	assert.equal(request(`/api/workspaces/${chat.thread.workspaceId}`, { headers }).status, 200);
	assert.equal(
		docker(
			"exec",
			name,
			"git",
			"--git-dir",
			`/data/repositories/${project.id}.git`,
			"log",
			"-1",
			"--format=%an|%ae|%cn|%ce",
		),
		`${settings.gitName}|${settings.gitEmail}|${settings.gitName}|${settings.gitEmail}`,
	);
	assert.equal(
		request(`/api/agents/${chat.thread.id}/messages`, {
			method: "POST",
			headers,
			body: JSON.stringify({ text: "" }),
		}).status,
		400,
	);
	assert.equal(JSON.parse(request(`/api/projects/${project.id}/agents`, { headers }).body)[0].id, chat.thread.id);
	const createdTicket = request(`/api/projects/${project.id}/tickets`, {
		method: "POST",
		headers,
		body: JSON.stringify({ title: "Persistent ticket", description: "Simple scope" }),
	});
	assert.equal(createdTicket.status, 201);
	const ticket = JSON.parse(createdTicket.body);
	assert.equal(ticket.id, "FORGE-1");
	assert.equal(ticket.status, "backlog");
	assert.equal(
		request(`/api/tickets/${ticket.id}/move`, { method: "POST", headers, body: JSON.stringify({ status: "done" }) })
			.status,
		409,
	);
	const workspaceResponse = request(`/api/projects/${project.id}/workspaces`, {
		method: "POST",
		headers,
		body: '{"name":"Terminal smoke"}',
	});
	assert.equal(workspaceResponse.status, 201);
	const workspace = JSON.parse(workspaceResponse.body);
	const file = request(`/api/workspaces/${workspace.id}/file`, {
		method: "POST",
		headers,
		body: JSON.stringify({ path: "review.ts", content: "export const reviewed = true;\n" }),
	});
	assert.equal(file.status, 201);
	assert.equal(
		request(`/api/workspaces/${workspace.id}/stage`, {
			method: "POST",
			headers,
			body: JSON.stringify({ paths: ["review.ts"] }),
		}).status,
		200,
	);
	const committed = request(`/api/workspaces/${workspace.id}/commit`, {
		method: "POST",
		headers,
		body: JSON.stringify({ message: "Add review file", expectedHead: workspace.head }),
	});
	assert.equal(committed.status, 200);
	const previewResponse = request(`/api/workspaces/${workspace.id}/pull-request-revision`, { headers });
	assert.equal(previewResponse.status, 200);
	const preview = JSON.parse(previewResponse.body);
	assert.equal(preview.hasChanges, true);
	const expected = { expectedHead: preview.revision.head, expectedBase: preview.revision.baseSha };
	const createdPr = request(`/api/projects/${project.id}/pull-requests`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			workspaceId: workspace.id,
			title: "Production review",
			body: "Image smoke",
			...expected,
		}),
	});
	assert.equal(createdPr.status, 201);
	const pr = JSON.parse(createdPr.body);
	const prDiff = request(`/api/pull-requests/${pr.id}/diff`, { headers });
	assert.equal(prDiff.status, 200);
	assert.match(JSON.parse(prDiff.body).diff.patch, /\+export const reviewed = true/u);
	const reviewed = request(`/api/pull-requests/${pr.id}/reviews`, {
		method: "POST",
		headers,
		body: JSON.stringify({ ...expected, decision: "approve", body: "Verified image" }),
	});
	assert.equal(reviewed.status, 200);
	assert.equal(JSON.parse(reviewed.body).approval, "approved");
	for (const status of ["closed", "open"])
		assert.equal(
			JSON.parse(
				request(`/api/pull-requests/${pr.id}`, {
					method: "PATCH",
					headers,
					body: JSON.stringify({ ...expected, status }),
				}).body,
			).status,
			status,
		);
	const terminalResponse = request(`/api/workspaces/${workspace.id}/terminal`, {
		method: "POST",
		headers,
		body: '{"cols":80,"rows":24}',
	});
	assert.equal(terminalResponse.status, 201);
	const terminal = JSON.parse(terminalResponse.body);
	assert.equal(terminal.status, "running");
	// Real production glibc addon, nonroot PTY and authenticated upgrade. Leave the shell
	// alive after detaching to exercise application shutdown below.
	const terminalProbe = [
		"printf 'PTY:%s USER:%s BASH:%s GIT:%s <%s>'",
		'ok "$(id -un)" "$BASH_VERSION"',
		'"$(git config --get user.name)" "$(git config --get user.email)"\r',
	].join(" ");
	assert.equal(
		execute(`
		import WebSocket from 'ws';
		const client = new WebSocket('ws://127.0.0.1:8080/api/terminals/${terminal.id}/socket?after=0', {headers:${JSON.stringify(headers)}});
		let output = '';
		await new Promise((resolve,reject) => {
			const timeout = setTimeout(()=>reject(Error('terminal smoke timed out')),5000);
			client.on('error',reject);
			client.on('message',bytes=>{
				const frame=JSON.parse(bytes.toString());
				if(frame.type==='status' && frame.session.status==='running') client.send(JSON.stringify({type:'input',data:${JSON.stringify(terminalProbe)}}));
				if(frame.type==='output') output+=frame.data;
				if(/PTY:ok USER:agent BASH:\\d+\\.\\d+/.test(output) && output.includes(${JSON.stringify(`GIT:${settings.gitName} <${settings.gitEmail}>`)})) { clearTimeout(timeout); client.terminate(); resolve(); }
			});
		});
		console.log('pty-ok');
	`),
		"pty-ok",
	);
	// Real shipped CLI/protocol, no live login or credentials.
	const accounts = JSON.parse(request("/api/accounts", { headers }).body);
	assert.equal(accounts.codex.connection, "available");
	assert.equal(accounts.github.connection, "available");
	assert.equal(accounts.codex.account, undefined);
	assert.match(docker("exec", name, "./node_modules/.bin/codex", "--version"), /0\.164\.0/);
	assert.match(docker("exec", name, "gh", "auth", "login", "--help"), /--insecure-storage/);
	execute(
		`import {stat,writeFile} from '@forge/backend-infrastructure/file'; for (const path of ['/data','/data/codex','/data/github']) { const s=await stat(path); if ((s.mode & 511)!==448 || s.uid!==1000) throw Error('unsafe data permissions'); } await writeFile('/data/codex/persistence-probe','test-only',{mode:384});`,
	);
	const orphan = execute(
		`import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setTimeout(()=>{},100)'],{detached:true,stdio:'ignore'}); child.unref(); console.log(child.pid);`,
	);
	await waitFor(() =>
		assert.equal(
			execute(
				`import {lstat} from '@forge/backend-infrastructure/file'; console.log(await lstat('/proc/${orphan}').then(()=>false,()=>true));`,
			),
			"true",
		),
	);
	docker("stop", "--time", "10", name);
	assert.equal(JSON.parse(docker("inspect", name))[0].State.ExitCode, 0);
	assert.doesNotMatch(docker("logs", name), /exited unsuccessfully|Forge shutting down|Codex disconnected/);
	docker("start", name);
	await waitFor(() => assert.equal(request("/health").status, 200));
	await waitFor(() => assert.equal(nested("volume", "ls", "-q"), ""));
	assert.equal(nested("ps", "-aq"), "");
	assert.equal(nested("image", "ls", "-aq"), "");
	assert.equal(JSON.parse(request(`/api/terminals/${terminal.id}`, { headers }).body).status, "closed");
	assert.equal(JSON.parse(request("/api/projects", { headers }).body)[0].id, project.id);
	assert.equal(JSON.parse(request(`/api/agents/${chat.thread.id}`, { headers }).body).thread.status, "idle");
	assert.equal(JSON.parse(request(`/api/tickets/${ticket.id}`, { headers }).body).status, "backlog");
	const persistedPr = request(`/api/pull-requests/${pr.id}`, { headers });
	assert.equal(persistedPr.status, 200);
	assert.equal(JSON.parse(persistedPr.body).approval, "approved");
	assert.equal(JSON.parse(persistedPr.body).discussion[0].body, "Verified image");
	assert.equal(
		execute(
			`import {readFile} from '@forge/backend-infrastructure/file'; console.log(await readFile('/data/codex/persistence-probe'));`,
		),
		"test-only",
	);
	// A broken provider home cannot withhold project HTTP, and repair recovers without another restart.
	docker("stop", "--time", "10", name);
	docker(
		"run",
		"--rm",
		"--user",
		"agent",
		"--mount",
		`type=volume,source=${volume},target=/data`,
		image,
		"node",
		"--input-type=module",
		"-e",
		"import {rename,writeFile} from '@forge/backend-infrastructure/file';await rename('/data/github','/data/github-backup');await writeFile('/data/github','test-only broken home');",
	);
	normalLogs = docker("logs", name);
	docker("rm", name);
	docker("run", "-d", "--name", name, "--mount", `type=volume,source=${volume},target=/data`, ...env, image);
	await waitFor(() => assert.equal(request("/health").status, 200));
	assert.deepEqual(JSON.parse(request("/api/settings", { headers }).body), settings);
	assert.equal(
		execute(
			"import {readFile} from '@forge/backend-infrastructure/file'; console.log(await readFile('/data/codex/persistence-probe'));",
		),
		"test-only",
	);
	await waitFor(() => assert.equal(nested("ps", "-aq"), ""));
	assert.equal(nested("image", "ls", "-aq"), "");
	docker("exec", "-u", "root", name, "pkill", "-TERM", "-x", "dockerd");
	await waitFor(() => assert.equal(JSON.parse(request("/api/board/docker", { headers }).body).available, false));
	assert.equal(request("/api/board/settings", { headers }).status, 200);
	assert.equal(request("/health").status, 200);
	assertGitIdentity();
	assert.equal(JSON.parse(request("/api/projects", { headers }).body)[0].id, project.id);
	assert.equal(JSON.parse(request("/api/accounts", { headers }).body).github.connection, "unavailable");
	execute(
		"import {rm,rename} from '@forge/backend-infrastructure/file';await rm('/data/github');await rename('/data/github-backup','/data/github');",
	);
	assert.equal(JSON.parse(request("/api/accounts", { headers }).body).github.connection, "available");
	// Real HTTP/SQLite/lifecycle with a controlled remote-Git CLI peer; no external import or TLS bypass.
	docker("stop", "--time", "10", name);
	normalLogs += `\n${docker("logs", name)}`;
	docker("rm", name);
	docker(
		"run",
		"-d",
		"--user",
		"agent",
		"--name",
		name,
		"--mount",
		`type=volume,source=${volume},target=/data`,
		"--mount",
		`type=bind,source=${fileURLToPath(new URL("fixtures", import.meta.url))},target=/fixtures,readonly`,
		...env,
		"-e",
		"FORGE_IMPORT_HOSTS=example.com",
		image,
		"node",
		"/fixtures/import-bootstrap.mjs",
	);
	await waitFor(() => assert.equal(request("/health").status, 200));
	const pendingRequest = spawn(
		"docker",
		[
			"exec",
			name,
			"node",
			"--input-type=module",
			"-e",
			`const r=await fetch('http://127.0.0.1:8080/api/projects',${JSON.stringify({ method: "POST", headers, body: JSON.stringify({ name: "Cancelled import", source: "https://example.com/repository.git" }) })}); console.log(r.status);`,
		],
		{ stdio: "ignore" },
	);
	const requestClosed = once(pendingRequest, "close");
	await waitFor(() =>
		assert.equal(
			execute(
				"import {readFile} from '@forge/backend-infrastructure/file';if(!await readFile('/data/slow-git.json'))process.exit(1);console.log('ready');",
			),
			"ready",
		),
	);
	docker("stop", "--time", "10", name);
	await requestClosed;
	assert.equal(JSON.parse(docker("inspect", name))[0].State.ExitCode, 0);
	docker("start", name);
	await waitFor(() => assert.equal(request("/health").status, 200));
	assert.equal(
		JSON.parse(request("/api/projects", { headers }).body).find((item) => item.name === "Cancelled import").status,
		"failed",
	);
	docker(
		"run",
		"--rm",
		"--user",
		"agent",
		...env,
		image,
		"node",
		"--input-type=module",
		"-e",
		"import {start} from './dist/start.js';import {Lifecycle} from './dist/http/lifecycle.js';const lifecycle=new Lifecycle();const started=start(lifecycle);await lifecycle.shutdown();await started;",
	);
	// Fail after opening SQLite to prove partial-startup cleanup exits promptly.
	assert.throws(
		() => docker("run", "--rm", ...env, "--mount", "type=tmpfs,target=/app/packages/frontend/dist", image),
		(error) => error.status === 1,
	);
	// A real bind error follows the same fatal cleanup path.
	assert.throws(
		() =>
			docker(
				"run",
				"--rm",
				"--user",
				"agent",
				...env,
				image,
				"node",
				"--input-type=module",
				"-e",
				"import {createServer} from 'node:http';const server=createServer();server.listen(8080,'0.0.0.0',()=>import('./dist/main.js'));",
			),
		(error) => error.status === 1,
	);
	console.log(
		"Forge image smoke passed: private HTTP boundary, assets, Git/SQLite persistence, restricted nonroot data, nvm login-shell execution, real Codex account protocol, gh flags, tini orphan reaping, graceful signal and partial/fatal startup.",
	);
} catch (error) {
	console.error(docker("logs", name));
	throw error;
} finally {
	try {
		const directory = fileURLToPath(new URL("../artifacts/forge", import.meta.url));
		await mkdir(directory, { recursive: true });
		const architecture = docker("image", "inspect", "--format", "{{.Architecture}}", image);
		await writeFile(
			`${directory}/image-${architecture}.log`,
			`${docker("image", "inspect", "--format", "{{.Id}}", image)}\n${normalLogs}\n${docker("logs", name)}\n${docker("inspect", name)}`,
		);
	} finally {
		try {
			docker("rm", "-f", name);
		} finally {
			docker("volume", "rm", volume);
		}
	}
}
