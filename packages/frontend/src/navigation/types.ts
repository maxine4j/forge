export type ForgeRoute =
	| { page: "projects" | "config" | "not-found" }
	| { page: "project"; projectId: string; section: string; threadId?: string };
