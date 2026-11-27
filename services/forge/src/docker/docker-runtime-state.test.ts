import { expect, test, vi } from "vitest";

import { DockerRuntimeState } from "./docker-runtime-state.ts";

test("each startup removes only disposable daemon roots, socket and pidfile", async () => {
	const rm = vi.fn(async () => {});
	const state = new DockerRuntimeState({ rm });
	await state.reset();
	await state.reset();
	expect(rm.mock.calls).toEqual([
		...Array.from({ length: 2 }, () => [
			["/var/lib/forge-docker", { recursive: true, force: true }],
			["/run/forge-docker", { recursive: true, force: true }],
			["/run/forge-docker.pid", { recursive: true, force: true }],
			["/run/forge/docker.sock", { recursive: true, force: true }],
		]).flat(),
	]);
});
