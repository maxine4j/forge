import { matchPath } from "react-router";

import type { ForgeRoute } from "./types.ts";

export const resolveRoute = (pathname: string): ForgeRoute => {
	if (matchPath("/", pathname) || matchPath("/projects", pathname)) return { page: "projects" };
	if (matchPath("/config", pathname)) return { page: "config" };
	const match = matchPath("/projects/:projectId/:section/:threadId?", pathname);
	const { projectId, section, threadId } = match?.params ?? {};
	if (
		projectId
		&& section
		&& ["code", "tasks", "agents", "pipelines", "terminals", "cost"].includes(section)
		&& (!threadId || section === "agents")
	)
		return { page: "project", projectId, section, ...(threadId ? { threadId } : {}) };
	return { page: "not-found" };
};
