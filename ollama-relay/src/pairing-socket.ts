import { Buffer } from "node:buffer";
import { validateHeaderValue } from "node:http";

import type { RawData, WebSocket } from "ws";

import { maxChunkBytes, type RelayFrame } from "./types.ts";

export const sendFrame = (socket: WebSocket, frame: RelayFrame | Buffer): Promise<void> =>
	new Promise((resolve, reject) => {
		socket.send(Buffer.isBuffer(frame) ? frame : JSON.stringify(frame), (error) => {
			if (error) reject(error);
			else resolve();
		});
	});

export const messageBytes = (data: RawData): Buffer =>
	Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);

export const readFrame = (data: Buffer): RelayFrame => {
	if (data.length > 1024) throw new Error("Invalid relay control frame");
	const frame: unknown = JSON.parse(data.toString("utf8"));
	if (
		!frame
		|| typeof frame !== "object"
		|| !("id" in frame)
		|| typeof frame.id !== "number"
		|| !Number.isSafeInteger(frame.id)
		|| frame.id <= 0
		|| !("type" in frame)
	)
		throw new Error("Invalid relay control frame");
	const { id, type } = frame;
	switch (type) {
		case "request":
		case "ack":
		case "cancel":
		case "end":
		case "cancelled":
		case "failed":
			return { id, type };
		case "headers": {
			if (
				!("status" in frame)
				|| typeof frame.status !== "number"
				|| !Number.isInteger(frame.status)
				|| frame.status < 200
				|| frame.status > 599
				|| !("contentType" in frame)
				|| typeof frame.contentType !== "string"
				|| frame.contentType.length > 256
			)
				throw new Error("Invalid relay response headers");
			validateHeaderValue("Content-Type", frame.contentType);
			return { id, type, status: frame.status, contentType: frame.contentType };
		}
		default:
			throw new Error("Unknown relay control frame");
	}
};

export const readChunk = (data: Buffer): Buffer => {
	if (data.length === 0 || data.length > maxChunkBytes) throw new Error("Invalid relay response chunk");
	return data;
};
