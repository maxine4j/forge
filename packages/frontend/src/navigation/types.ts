export type ForgeRoute =
	| { page: "repos" | "tasks" | "config" | "costs" | "not-found" }
	| { page: "repo"; repositoryId: string; section: string; threadId?: string };

export type ModalOwner =
	| "ticket"
	| "epic"
	| "create-ticket"
	| "create-epic"
	| "create-repo"
	| "board-settings"
	| "archive"
	| "return";
export interface ModalEntry {
	id: string;
	owner: ModalOwner;
	depth: number;
	parent: { url: string; state: NavigationState };
	selection?: string;
}
export interface NavigationState {
	modal?: ModalEntry;
	chatList?: { url: string; depth: number };
}
