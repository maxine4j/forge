import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

import Router from "@koa/router";
import { expect, test } from "vitest";

import { AccessService } from "../../src/auth/access-service.ts";
import type { Actor } from "../../src/auth/types.ts";
import { DockerClient } from "../../src/docker/docker-client.ts";
import { DockerError } from "../../src/docker/docker-command.ts";
import { DockerRouter } from "../../src/docker/docker-router.ts";
import { DockerService } from "../../src/docker/docker-service.ts";
import { HttpApplication } from "../../src/http/http-application.ts";

test("Docker HTTP enforces owner/origin and full IDs, filters data, and exposes asynchronous unavailable cleanup", async () => {
	const id = "a".repeat(64);
	let unavailable = false;
	const client = new DockerClient({
		run: async (args) => {
			if (unavailable) throw new DockerError();
			if (args[0] === "container" && args[1] === "ls") return id;
			if (args[0] === "container" && args[1] === "inspect")
				return JSON.stringify({
					Id: id,
					Name: "/test",
					Image: "sha256:image",
					Config: { Image: "test", Env: ["TOKEN=secret"] },
					State: { Running: true, Status: "running" },
					Mounts: [],
					NetworkSettings: { Networks: {}, Ports: {} },
				});
			return "";
		},
	});
	const access = new AccessService({ owner: "owner", origin: "https://forge.test" });
	const service = new DockerService(client, access, randomUUID, () => new Date());
	const server = createServer(
		new HttpApplication({ create: () => new Router<{ actor: Actor }>() }, access)
			.create([new DockerRouter(service)])
			.callback(),
	);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No address");
	const request = (path = "", method = "GET", user = "owner", origin = "https://forge.test") =>
		fetch(`http://127.0.0.1:${address.port}/api/board/docker${path}`, {
			method,
			headers: { "x-webauth-user": user, origin },
		});
	try {
		expect((await request("", "GET", "guest")).status).toBe(403);
		expect((await request("/cleanup", "POST", "owner", "https://evil.test")).status).toBe(403);
		for (const invalid of ["short", "all", "-force", "a".repeat(63)])
			expect((await request(`/containers/${invalid}/cleanup`, "POST")).status).toBe(400);
		const response = await request();
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("test");
		expect(body).not.toMatch(/TOKEN|secret|Env|Mounts/);
		expect((await request(`/operations/${randomUUID()}`)).status).toBe(404);
		unavailable = true;
		expect(await (await request()).json()).toMatchObject({ available: false, containers: [] });
		const cleanup = await request("/cleanup", "POST");
		expect(cleanup.status).toBe(202);
		const operation = (await cleanup.json()) as { id: string };
		const progress = await request(`/operations/${operation.id}`);
		expect(progress.status).toBe(200);
		expect(await progress.json()).toMatchObject({ status: "partial", remaining: null });
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
