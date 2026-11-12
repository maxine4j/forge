export type ForgeRoute =
	| { page: "projects" | "config" | "costs" | "not-found" }
	| { page: "project"; projectId: string; section: string; threadId?: string };
