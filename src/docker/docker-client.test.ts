import { expect, test, vi } from "vitest";

import { DockerClient } from "./docker-client.ts";
import { DockerError } from "./docker-command.ts";

const id = "a".repeat(64);
export const dockerInspection = {
	Id: id,
	Image: "sha256:image",
	Name: "/workload",
	Config: { Image: "app:latest", Env: ["TOKEN=secret"] },
	State: { Running: true, Status: "running" },
	Mounts: [
		{ Type: "bind", Source: "/data/credentials", Destination: "/source" },
		{ Type: "volume", Name: "data" },
	],
	NetworkSettings: {
		Networks: { bridge: {}, custom: {} },
		Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8081" }] },
	},
	Secret: "credential",
};

test("projects inspection to safe fields and never attributes bind directories to cleanup", async () => {
	const command = { run: vi.fn(async () => JSON.stringify(dockerInspection)) };
	const result = await new DockerClient(command).inspect(id);
	expect(result).toMatchObject({
		volumes: ["data"],
		networks: ["custom"],
		summary: { name: "workload", ports: "127.0.0.1:8081 → 80/tcp" },
	});
	expect(JSON.stringify(result)).not.toMatch(/TOKEN|secret|credential|\/data/);
	command.run.mockResolvedValue('{"Id":"invalid"}');
	await expect(new DockerClient(command).inspect(id)).rejects.toThrow("docker-unavailable");
});

test("missing resources are idempotent; other failures stay explicit; images and volumes never use force", async () => {
	const command = {
		run: vi.fn(async () => {
			throw new DockerError("docker-resource-missing");
		}),
	};
	const client = new DockerClient(command);
	await expect(client.inspect(id)).resolves.toBeUndefined();
	await expect(client.remove("container", id)).resolves.toBeUndefined();
	expect(command.run).toHaveBeenLastCalledWith(["container", "rm", "--force", "--volumes", "--", id]);
	await client.remove("image", "app:latest");
	expect(command.run).toHaveBeenLastCalledWith(["image", "rm", "--", "app:latest"]);
	await client.remove("volume", "data");
	expect(command.run).toHaveBeenLastCalledWith(["volume", "rm", "--", "data"]);
	command.run.mockRejectedValue(new DockerError());
	await expect(client.remove("container", id)).rejects.toThrow("docker-unavailable");
});

test("accepts uninitialized mount and network maps on created or stopped containers", async () => {
	const client = new DockerClient({
		run: async () =>
			JSON.stringify({
				...dockerInspection,
				Mounts: null,
				NetworkSettings: { Networks: null, Ports: null },
				State: { Running: false, Status: "created" },
			}),
	});
	expect(await client.inspect(id)).toMatchObject({
		running: false,
		volumes: [],
		networks: [],
		summary: { ports: "", status: "created" },
	});
});

test("validates stats and targets both global pruning commands with bounded deadlines", async () => {
	const command = {
		run: vi.fn(async () =>
			JSON.stringify({
				ID: id,
				CPUPerc: "2%",
				MemUsage: "1MiB / 1GiB",
				NetIO: "0B / 0B",
				BlockIO: "1kB / 2kB",
				PIDs: "3",
				Env: "secret",
			}),
		),
	};
	const client = new DockerClient(command);
	expect((await client.stats()).get(id)).toEqual({
		cpu: "2%",
		memory: "1MiB / 1GiB",
		network: "0B / 0B",
		block: "1kB / 2kB",
		processes: "3",
	});
	await client.prune();
	expect(command.run).toHaveBeenLastCalledWith(["system", "prune", "-a", "--volumes", "--force"], 120_000);
	await client.pruneVolumes();
	expect(command.run).toHaveBeenLastCalledWith(["volume", "prune", "-a", "--force"], 120_000);
});
