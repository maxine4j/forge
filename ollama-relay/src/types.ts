export type RelayFrame =
	| { type: "request" | "ack" | "cancel" | "end" | "cancelled" | "failed"; id: number }
	| { type: "headers"; id: number; status: number; contentType: string };

export const maxRequestBytes = 16 * 1024 * 1024;
export const maxChunkBytes = 64 * 1024;
