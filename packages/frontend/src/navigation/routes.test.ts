import { expect, test } from "vitest";

import { resolveRoute } from "./routes.ts";

test("recognizes projects, configuration, project sections and chat deep links", () => {
	expect(resolveRoute("/")).toEqual({ page: "projects" });
	expect(resolveRoute("/projects")).toEqual({ page: "projects" });
	expect(resolveRoute("/costs")).toEqual({ page: "costs" });
	expect(resolveRoute("/config")).toEqual({ page: "config" });
	for (const section of ["code", "tasks", "agents", "pipelines", "terminals"])
		expect(resolveRoute(`/projects/project/${section}`)).toEqual({
			page: "project",
			projectId: "project",
			section,
		});
	expect(resolveRoute("/projects/project/agents/chat")).toEqual({
		page: "project",
		projectId: "project",
		section: "agents",
		threadId: "chat",
	});
});

test("unknown paths and nested non-chat routes do not silently show the project list", () => {
	for (const path of [
		"/projects/project/cost",
		"/missing",
		"/projects/project/nope",
		"/projects/project/code/chat",
		"/config/extra",
	])
		expect(resolveRoute(path), path).toEqual({ page: "not-found" });
});
