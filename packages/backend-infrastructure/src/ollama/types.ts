export type RelayFrame =
	| { type: "request" | "list-models" | "ack" | "cancel" | "end" | "cancelled" | "failed"; id: number }
	| { type: "headers"; id: number; status: number; contentType: string };

export const maxRequestBytes = 16 * 1024 * 1024;
export const maxChunkBytes = 64 * 1024;
export const isWorkerId = (id: string): boolean =>
	/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(id) && !/[^a-z0-9-]/u.test(id);
