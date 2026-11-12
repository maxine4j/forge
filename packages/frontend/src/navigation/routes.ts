import { matchPath } from "react-router";

import type { ForgeRoute } from "./types.ts";

export const resolveRoute = (pathname: string): ForgeRoute => {
	if (matchPath("/", pathname) || matchPath("/tasks", pathname)) return { page: "tasks" };
	if (matchPath("/repos", pathname)) return { page: "repos" };
	if (matchPath("/config", pathname)) return { page: "config" };
	if (matchPath("/costs", pathname)) return { page: "costs" };
	const match = matchPath("/repos/:repositoryId/:section/:threadId?", pathname);
	const { repositoryId, section, threadId } = match?.params ?? {};
	if (
		repositoryId
		&& section
		&& ["code", "agents", "pipelines", "terminals"].includes(section)
		&& (!threadId || section === "agents")
	)
		return { page: "repo", repositoryId, section, ...(threadId ? { threadId } : {}) };
	return { page: "not-found" };
};
