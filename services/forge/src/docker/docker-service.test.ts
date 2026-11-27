import { randomUUID } from "node:crypto";

import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import type { DockerInspection, IDockerClient } from "./docker-client.ts";
import { DockerService } from "./docker-service.ts";

const actor = { username: "owner" };
const targetId = "a".repeat(64);
const otherId = "b".repeat(64);
const item = (id = targetId): DockerInspection => ({
	id,
	image: "sha256:image",
	volumes: ["named", "anonymous"],
	networks: ["custom"],
	running: true,
	summary: { id, name: "test", image: "test:latest", status: "running", ports: "", stats: null },
});
const fixture = () => {
	let containers = [item()];
	const calls: string[] = [];
	const client: IDockerClient = {
		containers: vi.fn(async () => containers),
		inspect: vi.fn(async () => containers.find((value) => value.id === targetId)),
		stats: vi.fn(async () => new Map()),
		resources: vi.fn(async () => ({
			containers: containers.map((value) => value.id),
			images: [],
			volumes: [],
			networks: [],
			buildCache: [],
		})),
		remove: vi.fn(async (kind, id) => {
			calls.push(`${kind}:${id}`);
			if (kind === "container") containers = containers.filter((value) => value.id !== id);
		}),
		imageTags: vi.fn(async () => ["test:latest", "test:second"]),
		prune: vi.fn(async () => {
			calls.push("prune");
		}),
		pruneVolumes: vi.fn(async () => {
			calls.push("volumes");
		}),
	};
	const service = new DockerService(
		client,
		new AccessService({ owner: "owner", origin: "https://forge.test" }),
		randomUUID,
		() => new Date(),
	);
	const finish = async (id: string) => {
		await vi.waitFor(() => expect(service.operation(actor, id).status).not.toBe("running"));
		return service.operation(actor, id);
	};
	return {
		client,
		service,
		calls,
		finish,
		setContainers: (value: DockerInspection[]) => {
			containers = value;
		},
	};
};

test("individual cleanup captures resources, removes container first, named volumes, networks and all image tags", async () => {
	const f = fixture();
	const op = f.service.cleanup(actor, targetId);
	expect(op.status).toBe("running");
	expect((await f.finish(op.id)).status).toBe("completed");
	expect(f.calls).toEqual([
		`container:${targetId}`,
		"volume:named",
		"volume:anonymous",
		"network:custom",
		"image:test:latest",
		"image:test:second",
		"image:sha256:image",
	]);
	expect(f.client.prune).not.toHaveBeenCalled();
	f.calls.length = 0;
	await f.finish(f.service.cleanup(actor, targetId).id);
	expect(f.calls).toEqual([]);
});

test("preserves shared resources, including references from stopped containers", async () => {
	const f = fixture();
	f.setContainers([item(), { ...item(otherId), running: false }]);
	const result = await f.finish(f.service.cleanup(actor, targetId).id);
	expect(f.calls).toEqual([`container:${targetId}`]);
	expect(result.retained).toHaveLength(4);
	expect(result.remaining?.containers).toEqual([otherId]);
});

test("already-removed target succeeds without daemon-wide pruning", async () => {
	const f = fixture();
	f.setContainers([]);
	expect((await f.finish(f.service.cleanup(actor, targetId).id)).status).toBe("completed");
	expect(f.calls).toEqual([]);
});

test("partial failures continue cleanup, retain a snapshot for retry, and sanitize errors", async () => {
	const f = fixture();
	vi.mocked(f.client.remove).mockImplementationOnce(async () => {
		throw new Error("secret credential");
	});
	const result = await f.finish(f.service.cleanup(actor, targetId).id);
	expect(result.status).toBe("partial");
	expect(result.failures).toEqual([`Remove container ${targetId}`]);
	expect(JSON.stringify(result)).not.toContain("secret");
	expect((await f.finish(f.service.cleanup(actor, targetId).id)).status).toBe("completed");
});

test("retry cleans a failed named volume after the container is gone", async () => {
	const f = fixture();
	const remove = f.client.remove;
	let fail = true;
	f.client.remove = async (kind, id) => {
		if (kind === "volume" && id === "named" && fail) {
			fail = false;
			throw new Error("timeout");
		}
		await remove(kind, id);
	};
	expect((await f.finish(f.service.cleanup(actor, targetId).id)).status).toBe("partial");
	expect((await f.finish(f.service.cleanup(actor, targetId).id)).status).toBe("completed");
	expect(f.calls).toContain("volume:named");
});

test("global cleanup includes stopped containers, both prune commands, and reports concurrent creation", async () => {
	const f = fixture();
	f.setContainers([item(), { ...item(otherId), running: false }]);
	vi.mocked(f.client.prune).mockImplementation(async () => {
		f.calls.push("prune");
		f.setContainers([item("c".repeat(64))]);
		throw new Error("prune timeout");
	});
	const result = await f.finish(f.service.cleanup(actor).id);
	expect(f.calls).toEqual([`container:${targetId}`, `container:${otherId}`, "prune", "volumes"]);
	expect(result.status).toBe("partial");
	expect(result.remaining?.containers).toEqual(["c".repeat(64)]);
});

test("serializes operations, validates IDs and enforces service owner access", async () => {
	const f = fixture();
	let release!: () => void;
	vi.mocked(f.client.prune).mockImplementation(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const op = f.service.cleanup(actor);
	expect(() => f.service.cleanup(actor)).toThrow("docker-busy");
	expect(() => f.service.cleanup(actor, "short")).toThrow("invalid-request");
	expect(() => f.service.cleanup({ username: "guest" })).toThrow("Access denied");
	await vi.waitFor(() => expect(release).toBeDefined());
	release();
	await f.finish(op.id);
	expect(f.service.cleanup(actor).id).not.toBe(op.id);
});

test("Docker outage and stale statistics leave the overview usable", async () => {
	const f = fixture();
	await expect(f.service.overview(actor)).resolves.toMatchObject({ available: true, statisticsStale: false });
	vi.mocked(f.client.stats).mockRejectedValue(new Error("timeout"));
	await expect(f.service.overview(actor)).resolves.toMatchObject({ available: true, statisticsStale: true });
	vi.mocked(f.client.containers).mockRejectedValue(new Error("secret"));
	await expect(f.service.overview(actor)).resolves.toMatchObject({ available: false, containers: [] });
	await expect(f.service.overview({ username: "guest" })).rejects.toThrow("Access denied");
});
