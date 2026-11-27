import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";

const suffix = randomUUID();
const network = `forge-discovery-${suffix}`;
const relay = `${network}-relay`;
const forge = `${network}-app`;
const token = "fixture-ollama-relay-token-1234567890";
const docker = (...args) =>
	execFileSync("docker", args, { encoding: "utf8", timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
const waitFor = async (probe, timeout = 90_000) => {
	const until = Date.now() + timeout;
	let failure;
	while (Date.now() < until) {
		try {
			return await probe();
		} catch (error) {
			failure = error;
			await pause(250);
		}
	}
	throw failure;
};
try {
	docker("network", "create", network);
	docker(
		"run",
		"-d",
		"--name",
		relay,
		"--network",
		network,
		"--network-alias",
		"ollama-relay",
		"-e",
		`OLLAMA_RELAY_TOKEN=${token}`,
		"forge-ollama-relay:dev",
	);
	await waitFor(() =>
		assert.equal(
			docker("exec", relay, "node", "-e", "fetch('http://127.0.0.1:8080/health').then(r=>console.log(r.status))"),
			"200",
		),
	);
	docker(
		"exec",
		"-d",
		relay,
		"node",
		"--input-type=module",
		"-e",
		`
		import WebSocket from 'ws';
		const worker = new WebSocket('ws://127.0.0.1:8080/pair', {headers:{Authorization:'Bearer ${token}', 'X-Forge-Worker-Id':'smoke-gpu'}});
		worker.on('open', () => { const report = () => worker.send(JSON.stringify({type:'telemetry',ready:true,contextWindow:32768,concurrency:1,hostMemory:null,loadedModels:null,gpus:[]})); report(); setInterval(report, 10000); });
	`,
	);
	await waitFor(() =>
		assert.match(
			docker(
				"exec",
				relay,
				"node",
				"-e",
				"fetch('http://127.0.0.1:8081/providers').then(r=>r.text()).then(console.log)",
			),
			/32768/,
		),
	);
	docker(
		"run",
		"-d",
		"--privileged",
		"--name",
		forge,
		"--network",
		network,
		"-e",
		"FORGE_OWNER=owner",
		"-e",
		"FORGE_ORIGIN=https://forge.example.test",
		"-e",
		"FORGE_OLLAMA_RELAY_ORIGIN=http://ollama-relay:8081",
		"forge:dev",
	);
	await waitFor(() => {
		const result = docker(
			"exec",
			"--user",
			"agent",
			forge,
			"node",
			"-e",
			`fetch('http://127.0.0.1:8080/api/model-providers',{headers:{'x-webauth-user':'owner'}}).then(r=>r.json()).then(x=>console.log(JSON.stringify(x)))`,
		);
		const providers = JSON.parse(result);
		assert.ok(
			providers.some(
				(provider) =>
					provider.name === "smoke-gpu"
					&& provider.contextWindow === 32768
					&& provider.supportedConcurrency === 1,
			),
		);
	});
} finally {
	for (const name of [forge, relay]) {
		try {
			docker("rm", "-f", name);
		} catch {}
	}
	try {
		docker("network", "rm", network);
	} catch {}
}
