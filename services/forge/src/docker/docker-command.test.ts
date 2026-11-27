import { fileURLToPath } from "node:url";

import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test } from "vitest";

import { DOCKER_HOST, DockerCommand } from "./docker-command.ts";

const command = (mode: string) =>
	new DockerCommand(sleep, process.execPath, [
		fileURLToPath(new URL("../../tests/fixtures/docker-cli-peer.mjs", import.meta.url)),
		mode,
	]);

test("CLI always receives fixed endpoint and literal arguments with no ambient credentials or contexts", async () => {
	const output = JSON.parse(await command("inspect").run(["image", "inspect", "$(touch never); --context hostile"]));
	expect(output.args).toEqual(["--host", DOCKER_HOST, "image", "inspect", "$(touch never); --context hostile"]);
	expect(Object.keys(output.env).sort()).toEqual(["DOCKER_CONFIG", "HOME", "LANG", "PATH"]);
	expect(output.env.DOCKER_CONFIG).toBe("/nonexistent");
});

test("CLI deadlines and output bounds terminate real child processes and sanitize diagnostics", async () => {
	await expect(command("hang").run(["stats"], 50)).rejects.toThrow("docker-unavailable");
	await expect(command("overflow").run(["stats"])).rejects.toThrow("docker-unavailable");
	await expect(command("failure").run(["stats"])).rejects.toThrow(/^docker-unavailable$/);
	await expect(command("missing").run(["network", "rm", "disappeared"])).rejects.toThrow("docker-resource-missing");
});

test("shutdown cancels owned CLI commands and rejects later work", async () => {
	const client = command("hang");
	const pending = client.run(["stats"]);
	const rejected = expect(pending).rejects.toThrow("docker-unavailable");
	await client.close();
	await rejected;
	await expect(client.run(["stats"])).rejects.toThrow("docker-unavailable");
});
