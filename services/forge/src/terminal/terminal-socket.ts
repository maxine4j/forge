import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

import type { ISleep } from "@forge/backend-infrastructure/sleep";
import {
	terminalClientMessageSchema,
	terminalSessionSchema,
	type TerminalServerMessage,
} from "@forge/contracts/terminal";
import WebSocket, { WebSocketServer } from "ws";

import { AccessDeniedError, type IAccessService } from "../auth/access-service.ts";
import type { Actor } from "../auth/types.ts";
import { TerminalError } from "./errors.ts";
import type { ITerminalService } from "./terminal-service.ts";
import type { TerminalAttachment } from "./types.ts";

export interface ITerminalSocket {
	register(server: Server): void;
	close(): Promise<void>;
}
export class TerminalSocket implements ITerminalSocket {
	private readonly sockets = new WebSocketServer({ noServer: true, maxPayload: 16384, perMessageDeflate: false });
	private readonly pending = new Set<Duplex>();
	private closed = false;
	constructor(
		private readonly terminals: ITerminalService,
		private readonly access: IAccessService,
		private readonly sleep: ISleep,
	) {}
	register(server: Server): void {
		server.on("upgrade", (request, socket, head) => {
			socket.on("error", () => {});
			if (this.closed || this.pending.size >= 16 || this.sockets.clients.size >= 32) {
				socket.destroy();
				return;
			}
			this.pending.add(socket);
			const deadline = new AbortController();
			void this.sleep(5000, deadline.signal).then(
				() => socket.destroy(),
				() => {},
			);
			void this.upgrade(request, socket, head)
				.catch((error: unknown) => {
					const status =
						error instanceof AccessDeniedError
							? 403
							: error instanceof TerminalError && error.code === "terminal-not-found"
								? 404
								: 400;
					if (!socket.destroyed)
						socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
				})
				.finally(() => {
					deadline.abort();
					this.pending.delete(socket);
				});
		});
	}
	async close(): Promise<void> {
		this.closed = true;
		for (const socket of this.pending) socket.destroy();
		for (const socket of this.sockets.clients) socket.terminate();
		await new Promise<void>((resolve) => this.sockets.close(() => resolve()));
	}
	private async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
		const identity = request.headersDistinct["x-webauth-user"];
		const origin = request.headersDistinct["origin"];
		const actor = this.access.authorize(
			identity?.length === 1 ? identity.at(0) : undefined,
			origin?.length === 1 ? origin.at(0) : undefined,
			true,
		);
		const url = new URL(request.url ?? "", "https://forge.invalid");
		const match = /^\/api\/terminals\/([^/]+)\/socket$/u.exec(url.pathname);
		const id = terminalSessionSchema.shape.id.safeParse(match?.at(1));
		const cursor = url.searchParams.getAll("after");
		if (
			!id.success
			|| cursor.length > 1
			|| [...url.searchParams.keys()].some((key) => key !== "after")
			|| (cursor.length === 1 && !/^\d{1,16}$/u.test(cursor.at(0) ?? ""))
		)
			throw new TerminalError("invalid-request");
		const after = Number(cursor.at(0) ?? "0");
		if (!Number.isSafeInteger(after)) throw new TerminalError("invalid-request");
		await this.terminals.get(actor, id.data);
		if (this.closed || socket.destroyed) return;
		this.sockets.handleUpgrade(request, socket, head, (client) => {
			void this.attach(client, actor, id.data, after);
		});
	}
	private async attach(client: WebSocket, actor: Actor, id: string, after: number): Promise<void> {
		const lifetime = new AbortController();
		let attachment: TerminalAttachment | undefined;
		let queued = 0;
		let pong = true;
		client.on("error", () => {});
		client.on("pong", () => {
			pong = true;
		});
		client.once("close", () => {
			lifetime.abort();
			attachment?.detach();
		});
		const send = (message: TerminalServerMessage) => {
			if (client.readyState !== WebSocket.OPEN) return;
			const data = JSON.stringify(message);
			if (client.bufferedAmount + Buffer.byteLength(data) > 262144) {
				client.terminate();
				return;
			}
			client.send(data, (error) => {
				if (error) client.terminate();
			});
		};
		try {
			const ready = this.terminals.attach(actor, id, after, send);
			client.on("message", (data, binary) => {
				if (binary || queued >= 4) {
					client.close(1008, "Invalid terminal frame");
					return;
				}
				let input: unknown;
				try {
					input = JSON.parse(data.toString());
				} catch {
					client.close(1008, "Invalid terminal frame");
					return;
				}
				const parsed = terminalClientMessageSchema.safeParse(input);
				if (!parsed.success) {
					client.close(1008, "Invalid terminal frame");
					return;
				}
				queued++;
				void ready
					.then(() => this.terminals.input(actor, id, parsed.data))
					.catch(() => client.close(1008, "Terminal unavailable"))
					.finally(() => {
						queued--;
					});
			});
			attachment = await ready;
			if (client.readyState !== WebSocket.OPEN) {
				attachment.detach();
				return;
			}
			while (!lifetime.signal.aborted) {
				await this.sleep(30000, lifetime.signal);
				if (!pong) {
					client.terminate();
					return;
				}
				pong = false;
				client.ping();
			}
		} catch {
			client.close(1008, "Terminal unavailable");
		}
	}
}
