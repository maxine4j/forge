import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { sleep } from "@forge/backend-infrastructure/sleep";

const image = "forge-ollama-relay:dev";
const name = `forge-relay-smoke-${randomUUID()}`;
const token = "fixture-ollama-relay-token-1234567890";
const docker = (...args) =>
	execFileSync("docker", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const node = (...args) => docker("exec", name, "node", ...args);
const evaluate = (code) => node("--input-type=module", "-e", code);

try {
	docker(
		"run",
		"--detach",
		"--platform",
		"linux/amd64",
		"--network",
		"none",
		"--cpus",
		"0.5",
		"--memory",
		"192m",
		"--name",
		name,
		"-e",
		`OLLAMA_RELAY_TOKEN=${token}`,
		image,
	);
	assert.equal(docker("exec", name, "id", "-u"), "1000");
	const deadline = Date.now() + 10_000;
	while (true) {
		try {
			assert.equal(evaluate("console.log((await fetch('http://127.0.0.1:8080/health')).status)"), "200");
			break;
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await sleep(100);
		}
	}
	evaluate(`
		import assert from "node:assert/strict";
		import { once } from "node:events";
		import WebSocket from "ws";
		import { WorkerSession } from "./dist/worker-session.js";
		const request = (port, body = '{"stream":true}') => fetch(\`http://127.0.0.1:\${port}/v1/responses\`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
			signal: AbortSignal.timeout(10000),
		});
		assert.equal((await request(8080)).status, 404);
		assert.equal((await request(8081)).status, 503);
		const worker = new WebSocket("ws://127.0.0.1:8080/pair", {
			headers: { Authorization: "Bearer " + process.env.OLLAMA_RELAY_TOKEN },
		});
		const body = 'data: {"type":"response.completed"}\\n\\n';
		const limit = 16 * 1024 * 1024;
		const large = '{"input":"' + "a".repeat(limit - 12) + '"}';
		let waitingForRelease;
		let release;
		new WorkerSession(worker, {
			infer: async (input) => {
				if (waitingForRelease) {
					const gate = waitingForRelease;
					waitingForRelease = undefined;
					await gate;
				}
				if (input.length === limit) return new Response(String(input.length));
				assert.equal(input.toString(), '{"stream":true}');
				return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
			},
		});
		try {
			await once(worker, "open");
			const response = await request(8081);
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("content-type"), "text/event-stream");
			assert.equal(await response.text(), body);
			assert.equal(Buffer.byteLength(large), limit);
			assert.equal(await (await request(8081, large)).text(), String(limit));
			waitingForRelease = new Promise((resolve) => { release = resolve; });
			const requests = [request(8081, large), request(8081, large), request(8081, large)];
			assert.equal((await Promise.race(requests)).status, 429);
			release();
			const statuses = await Promise.all(requests.map(async (pending) => {
				const response = await pending;
				await response.text();
				return response.status;
			}));
			assert.deepEqual(statuses.sort(), [200, 200, 429]);
		} finally {
			worker.terminate();
		}
	`);
	docker("stop", "--time", "5", name);
	assert.equal(docker("inspect", "--format", "{{.State.ExitCode}}", name), "0");
} finally {
	docker("rm", "--force", name);
}
