import { createServer } from "node:http";

import { expect, test, vi } from "vitest";

import { TelemetryReceiver, telemetryArguments } from "./telemetry-receiver.ts";

test("private receiver authenticates, bounds bodies, validates paths, and drains accepted work", async () => {
	const accept = vi.fn(async () => {});
	const receiver = new TelemetryReceiver("ephemeral-secret", { accept });
	const server = createServer((req, res) => {
		void receiver.handle(req, res);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing listener");
	const url = `http://127.0.0.1:${address.port}`;
	const headers = { authorization: "Bearer ephemeral-secret", "content-type": "application/json" };
	try {
		expect((await fetch(`${url}/v1/traces`, { method: "POST", body: "{}" })).status).toBe(401);
		expect((await fetch(`${url}/v1/metrics`, { method: "POST", headers, body: "{}" })).status).toBe(404);
		expect((await fetch(`${url}/v1/logs`, { method: "POST", headers, body: "bad json" })).status).toBe(400);
		expect(
			(await fetch(`${url}/v1/logs`, { method: "POST", headers, body: "x".repeat(4 * 1024 * 1024 + 1) })).status,
		).toBe(413);
		expect((await fetch(`${url}/v1/traces`, { method: "POST", headers, body: "{}" })).status).toBe(200);
		await receiver.close();
		expect(accept).toHaveBeenCalledExactlyOnceWith({});
		expect(telemetryArguments(url, "ephemeral-secret").join(" ")).toContain("log_user_prompt=false");
	} finally {
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
	}
});
