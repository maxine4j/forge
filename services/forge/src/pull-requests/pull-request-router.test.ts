import { once } from "node:events";
import { createServer } from "node:http";

import Router from "@koa/router";
import { expect, test, vi } from "vitest";

import { AccessDeniedError, AccessService } from "../auth/access-service.ts";
import { HttpApplication } from "../http/http-application.ts";
import { ProjectRouter } from "../projects/project-router.ts";
import { PullRequestError } from "./errors.ts";
import { PullRequestRouter } from "./pull-request-router.ts";
import type { IPullRequestService } from "./pull-request-service.ts";

test("PR adapter maps only its own errors and never serializes raw diagnostics", async () => {
	let failure: Error = new Error("SQL private /data/credentials");
	const fail = async () => {
		throw failure;
	};
	const service: IPullRequestService = {
		create: fail,
		list: fail,
		get: fail,
		update: fail,
		comment: fail,
		review: fail,
		diff: fail,
		preview: fail,
	};
	const projects = { list: async () => [], create: vi.fn(), get: vi.fn(), retry: vi.fn(), recover: async () => {} };
	const downstream = new Router();
	downstream.get("/api/unrelated/error", async () => {
		throw new Error("Other service secret");
	});
	const server = createServer(
		new HttpApplication(
			new ProjectRouter(projects),
			new AccessService({ owner: "owner", origin: "https://forge.example" }),
		)
			.create([new PullRequestRouter(service), { create: () => downstream }])
			.callback(),
	);
	try {
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No listener");
		const request = (path: string) =>
			fetch(`http://127.0.0.1:${address.port}${path}`, { headers: { "x-webauth-user": "owner" } });
		const other = await request("/api/unrelated/error");
		expect(other.status).toBe(500);
		expect(await other.json()).toEqual({ error: "internal-error" });
		const unavailable = await request("/api/pull-requests/example");
		expect(unavailable.status).toBe(503);
		expect(await unavailable.json()).toEqual({ error: "pull-request-unavailable" });
		failure = new PullRequestError("pull-request-not-found");
		expect((await request("/api/pull-requests/example")).status).toBe(404);
		failure = new AccessDeniedError();
		expect((await request("/api/pull-requests/example")).status).toBe(403);
	} finally {
		await new Promise<void>((resolve) => {
			server.closeAllConnections();
			server.close(() => resolve());
		});
	}
});
