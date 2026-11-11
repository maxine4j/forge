import { once } from "node:events";

import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import { HttpApplication } from "../http/http-application.ts";
import { ProjectRouter } from "../projects/project-router.ts";
import { CostRouter } from "./cost-router.ts";

test("cost route uses owner access, validates the project ID and returns browser-safe stats", async () => {
	const id = "123e4567-e89b-42d3-a456-426614174000";
	const response = {
		since: "2026-11-11T00:00:00.000Z",
		totals: { input: 0, cached: 0, output: 0, turns: 0 },
		phases: [],
		tickets: [],
		days: [],
		monthlyAud: 30,
		audPerUsd: 1.5,
		exchangeDate: "2026-11-10",
	};
	const read = vi.fn(async () => response);
	const projects = { get: vi.fn(), list: vi.fn(), create: vi.fn(), retry: vi.fn(), recover: vi.fn() };
	const app = new HttpApplication(
		new ProjectRouter(projects),
		new AccessService({ owner: "owner", origin: "https://forge.test" }),
	);
	const server = app.create([new CostRouter({ read })]).listen(0, "127.0.0.1");
	try {
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No HTTP address");
		const get = (projectId: string, username: string) =>
			fetch(`http://127.0.0.1:${address.port}/api/projects/${projectId}/cost`, {
				headers: { "x-webauth-user": username },
			});
		expect((await get(id, "outsider")).status).toBe(403);
		expect((await get("invalid", "owner")).status).toBe(400);
		expect(await (await get(id, "owner")).json()).toEqual(response);
		expect(read).toHaveBeenCalledExactlyOnceWith({ username: "owner" }, id);
	} finally {
		server.close();
		await once(server, "close");
	}
});
