import { once } from "node:events";

import { expect, test, vi } from "vitest";

import { AccessService } from "../auth/access-service.ts";
import { HttpApplication } from "../http/http-application.ts";
import { ProjectRouter } from "../projects/project-router.ts";
import { CostRouter } from "./cost-router.ts";
import { CostService } from "./cost-service.ts";
import { summarizeCosts } from "./cost-summary.ts";

test("cost route uses owner access, removes project routes and returns browser-safe stats", async () => {
	const id = "123e4567-e89b-42d3-a456-426614174000";
	const response = {
		since: "2026-11-11T00:00:00.000Z",
		ticketEstimates: summarizeCosts([], []),
		chats: summarizeCosts([], []),
		quotaAttribution: [],
		totals: summarizeCosts([], []),
		phases: [],
		tickets: [],
		days: [],
	};
	const read = vi.fn(async () => response);
	const projects = { get: vi.fn(), list: vi.fn(), create: vi.fn(), retry: vi.fn(), recover: vi.fn() };
	const app = new HttpApplication(
		new ProjectRouter(projects),
		new AccessService({ owner: "owner", origin: "https://forge.test" }),
	);
	const history = vi.fn(async () => ({ since: response.since, turns: [] }));
	const service = new CostService(
		new AccessService({ owner: "owner", origin: "https://forge.test" }),
		{
			listForCost: async () => [],
			get: async (id) => (id === "TASK-1" ? { id } : undefined),
		},
		{ read: history },
		{ limits: async () => undefined },
		() => new Date(),
	);
	const server = app
		.create([new CostRouter({ read, readTicket: service.readTicket.bind(service) })])
		.listen(0, "127.0.0.1");
	try {
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No HTTP address");
		const get = (path: string, username: string) =>
			fetch(`http://127.0.0.1:${address.port}${path}`, {
				headers: { "x-webauth-user": username },
			});
		expect((await get("/api/costs", "outsider")).status).toBe(403);
		expect((await get(`/api/projects/${id}/cost`, "owner")).status).toBe(404);
		expect(await (await get("/api/costs", "owner")).json()).toEqual(response);
		expect(read).toHaveBeenCalledExactlyOnceWith({ username: "owner" });
		expect((await get("/api/tickets/TASK-1/cost", "outsider")).status).toBe(403);
		expect((await get("/api/tickets/invalid/cost", "owner")).status).toBe(400);
		expect((await get("/api/tickets/TASK-2/cost", "owner")).status).toBe(404);
		expect(await (await get("/api/tickets/TASK-1/cost", "owner")).json()).toEqual({
			phases: ["planning", "implementation", "review", "rebase"].map((phase) => ({
				phase,
				...summarizeCosts([], []),
			})),
			since: response.since,
			ticket: response.ticketEstimates,
		});
		expect(history).toHaveBeenCalledExactlyOnceWith("TASK-1");
		await expect(service.read({ username: "outsider" })).rejects.toThrow("Access denied");
		await expect(service.readTicket({ username: "outsider" }, "TASK-1")).rejects.toThrow("Access denied");
	} finally {
		server.close();
		await once(server, "close");
	}
});
