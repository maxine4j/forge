import { expect, test } from "vitest";

import { resolveRoute } from "./routes.ts";

test("recognizes projects, configuration, project sections", () => {
	expect(resolveRoute("/")).toEqual({ page: "tasks" });
	expect(resolveRoute("/tasks")).toEqual({ page: "tasks" });
	expect(resolveRoute("/repos")).toEqual({ page: "repos" });
	expect(resolveRoute("/costs")).toEqual({ page: "costs" });
	expect(resolveRoute("/config")).toEqual({ page: "config" });
	for (const section of ["code", "pipelines", "terminals"])
		expect(resolveRoute(`/repos/repository/${section}`)).toEqual({
			page: "repo",
			repositoryId: "repository",
			section,
		});
});

test("unknown paths and nested non-chat routes do not silently show the project list", () => {
	for (const path of [
		"/repos/repository/cost",
		"/missing",
		"/projects",
		"/projects/project/code",
		"/repos/repository/tasks",
		"/repos/repository/nope",
		"/repos/repository/code/chat",
		"/repos/repository/agents",
		"/repos/repository/agents/chat",
		"/config/extra",
	])
		expect(resolveRoute(path), path).toEqual({ page: "not-found" });
});
