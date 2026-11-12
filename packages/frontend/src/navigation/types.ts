export type ForgeRoute =
	| { page: "repos" | "tasks" | "config" | "costs" | "not-found" }
	| { page: "repo"; repositoryId: string; section: string; threadId?: string };
