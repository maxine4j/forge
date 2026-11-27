import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mkdtemp, rm } from "@forge/backend-infrastructure/file";
import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import type { TerminalServerMessage } from "@forge/contracts/terminal";
import { bodyParser } from "@koa/bodyparser";
import Koa from "koa";
import { expect, it, vi } from "vitest";
import WebSocket from "ws";

import { AccessService } from "../../src/auth/access-service.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { TerminalInventory } from "../../src/terminal/terminal-inventory.ts";
import { TerminalProcess } from "../../src/terminal/terminal-process.ts";
import { TerminalRouter } from "../../src/terminal/terminal-router.ts";
import { TerminalService } from "../../src/terminal/terminal-service.ts";
import { TerminalSocket } from "../../src/terminal/terminal-socket.ts";
import { TerminalStore } from "../../src/terminal/terminal-store.ts";
import type { IWorkspaceService } from "../../src/workspaces/workspace-service.ts";

const workspaceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const headers = { "x-webauth-user": "owner", origin: "https://forge.example", "content-type": "application/json" };

it.skipIf(process.platform !== "linux")(
	"authenticates upgrades before attach, reconnects the same PID, resizes, closes and records restart loss",
	async () => {
		const path = await mkdtemp(join(tmpdir(), "forge-terminal-http-"));
		const database = new SqliteDatabase(join(path, "test.sqlite"));
		await database.initialize();
		await database.run("CREATE TABLE workspaces (id TEXT PRIMARY KEY)");
		await database.run("INSERT INTO workspaces VALUES (?)", [workspaceId]);
		const store = new TerminalStore(database);
		await store.initialize();
		const access = new AccessService({ owner: "owner", origin: "https://forge.example" });
		const resolve = vi.fn(async () => ({ path, workspace: { id: workspaceId } }));
		const workspaces = { resolve, get: async () => ({ id: workspaceId }) } as unknown as IWorkspaceService;
		const service = new TerminalService(
			store,
			new TerminalProcess(process.env["PATH"] ?? "", sleep, new TerminalInventory(files), process.platform),
			workspaces,
			access,
			() => id,
			() => new Date(),
			sleep,
		);
		const sockets = new TerminalSocket(service, access, sleep);
		const app = new Koa();
		app.use(async (ctx, next) => {
			ctx.state["actor"] = access.authorize(
				ctx.headers["x-webauth-user"],
				ctx.headers["origin"],
				ctx.method !== "GET",
			);
			await next();
		});
		app.use(bodyParser());
		const router = new TerminalRouter(service).create();
		app.use(router.routes());
		const server = createServer(app.callback());
		sockets.register(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Listener unavailable");
		const base = `http://127.0.0.1:${address.port}`;
		const socketUrl = `ws://127.0.0.1:${address.port}/api/terminals/${id}/socket?after=0`;
		const clients: WebSocket[] = [];
		const open = async (url: string, supplied = headers) => {
			const client = new WebSocket(url, { headers: supplied });
			clients.push(client);
			const messages: TerminalServerMessage[] = [];
			client.on("message", (data) => messages.push(JSON.parse(data.toString())));
			await new Promise<void>((resolve, reject) => {
				client.once("open", resolve);
				client.once("error", reject);
			});
			return { client, messages };
		};
		try {
			expect(
				(
					await fetch(`${base}/api/workspaces/${workspaceId}/terminal`, {
						method: "POST",
						headers,
						body: JSON.stringify({ cols: 80, rows: 24 }),
					})
				).status,
			).toBe(201);
			const before = resolve.mock.calls.length;
			await expect(open(socketUrl, { ...headers, origin: "https://evil.example" })).rejects.toThrow("403");
			await expect(open(socketUrl, { ...headers, "x-webauth-user": "intruder" })).rejects.toThrow("403");
			expect(resolve).toHaveBeenCalledTimes(before);
			const first = await open(socketUrl);
			first.client.send(JSON.stringify({ type: "input", data: "printf 'PID:%s\\n' \"$$\"\r" }));
			const output = (messages: TerminalServerMessage[]) =>
				messages
					.filter((m) => m.type === "output")
					.map((m) => (m.type === "output" ? m.data : ""))
					.join("");
			await vi.waitFor(() => expect(output(first.messages)).toMatch(/PID:\d+/));
			const pid = /PID:(\d+)/.exec(output(first.messages))?.at(1);
			first.client.terminate();
			const second = await open(socketUrl);
			second.client.send(JSON.stringify({ type: "input", data: "printf 'AGAIN:%s\\n' \"$$\"\r" }));
			await vi.waitFor(() => expect(output(second.messages)).toContain(`AGAIN:${pid}`));
			second.client.send(JSON.stringify({ type: "resize", cols: 111, rows: 33 }));
			await vi.waitFor(() =>
				expect(second.messages.some((m) => m.type === "status" && m.session.cols === 111)).toBe(true),
			);
			second.client.send(JSON.stringify({ type: "input", data: "stty size\r" }));
			await vi.waitFor(() => expect(output(second.messages)).toContain("33 111"));
			expect((await fetch(`${base}/api/terminals/${id}`, { method: "DELETE", headers })).status).toBe(200);
			expect((await store.get(id))?.status).toBe("closed");
			await store.update({ ...(await service.get({ username: "owner" }, id)), status: "running" });
			await service.recover();
			expect((await store.get(id))?.status).toBe("lost");
		} finally {
			for (const client of clients) client.terminate();
			await sockets.close();
			await service.shutdown();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await database.close();
			await rm(path, { recursive: true, force: true });
		}
	},
	15000,
);
