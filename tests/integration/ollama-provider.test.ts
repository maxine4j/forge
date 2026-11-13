import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test, vi } from "vitest";
import { z } from "zod";

import { AccountProcess } from "../../src/accounts/account-process.ts";
import { CodexConnection } from "../../src/accounts/codex-connection.ts";
import { CodexAgentClient } from "../../src/codex/codex-agent-client.ts";

test("pinned Codex streams a custom-provider turn and resumes it after restart without sending OpenAI auth", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-provider-test-"));
	const requests: { url?: string; headers: Record<string, unknown>; body: string }[] = [];
	const syntheticToken = "forge-test-synthetic-chatgpt-token";
	const accountAuthorization: (string | undefined)[] = [];
	const server = createServer((request, response) => {
		if (request.url?.endsWith("/accounts/check") && request.url.startsWith("/chatgpt/")) {
			accountAuthorization.push(request.headers.authorization);
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({
					accounts: [
						{
							id: "synthetic-account",
							plan_type: "plus",
							workspace_backend_origin: "NO_CONSTRAINT",
							account_routing_override: "NO_CONSTRAINT",
						},
					],
				}),
			);
			return;
		}
		if (request.url !== "/v1/responses") {
			response.writeHead(404);
			response.end();
			return;
		}
		request.setEncoding("utf8");
		let body = "";
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => {
			requests.push({ url: request.url, headers: request.headers, body });
			const id = `response-${requests.length}`;
			const input = JSON.parse(body);
			const needsTool =
				body.includes("Run the fixture command") && !body.includes('"type":"function_call_output"');
			const answer = body.includes("Plan a greeting.")
				? "<proposed_plan>\n# Greeting\nSay hello.\n</proposed_plan>"
				: "Fixture answer";
			const output = needsTool
				? {
						id: "fixture-tool",
						type: "function_call",
						name: "exec_command",
						call_id: "fixture-call",
						arguments: JSON.stringify({ cmd: "echo forge-provider-tool" }),
						status: "completed",
					}
				: {
						id: `message-${requests.length}`,
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: answer, annotations: [] }],
					};
			if (input.model !== "fixture:latest" || body.includes("Fail the fixture turn")) {
				response.writeHead(400);
				response.end("Fixture rejects unsupported requests.");
				return;
			}
			const events = [
				{ type: "response.created", response: { id } },
				{ type: "response.output_item.done", output_index: 0, item: output },
				{
					type: "response.completed",
					response: {
						id,
						status: "completed",
						output: [output],
						usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
					},
				},
			];
			response.writeHead(200, { "Content-Type": "text/event-stream" });
			response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
		});
	});
	const processes = new AccountProcess(
		{
			dataDirectory: root,
			path: process.env["PATH"] ?? "",
			codexExecutable: resolve("node_modules/.bin/codex"),
			githubExecutable: "gh",
		},
		sleep,
	);
	const connection = new CodexConnection(processes, sleep);
	try {
		await processes.initialize();
		const claims = Buffer.from(
			JSON.stringify({
				email: "synthetic@example.test",
				"https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "synthetic-account" },
			}),
		).toString("base64url");
		await files.writeFile(
			join(root, "codex", "auth.json"),
			JSON.stringify({
				auth_mode: "chatgpt",
				tokens: {
					id_token: `e30.${claims}.fixture`,
					access_token: syntheticToken,
					refresh_token: "synthetic-refresh-token",
					account_id: "synthetic-account",
				},
				last_refresh: new Date().toISOString(),
			}),
			{ mode: 0o600 },
		);
		await new Promise<void>((ready, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", ready);
		});
		const address = z.object({ port: z.number() }).parse(server.address());
		await files.writeFile(
			join(root, "codex", "config.toml"),
			`chatgpt_base_url = "http://127.0.0.1:${address.port}/chatgpt/"\n[analytics]\nenabled = false\n`,
			{ mode: 0o600 },
		);
		await files.mkdir(join(root, "codex", "rules"), { recursive: true });
		await files.writeFile(
			join(root, "codex", "rules", "default.rules"),
			'prefix_rule(pattern=["echo", "forge-provider-tool"], decision="prompt")\n',
			{ mode: 0o600 },
		);
		const provider = {
			kind: "ollama",
			endpoint: `http://127.0.0.1:${address.port}/v1`,
			model: "fixture:latest",
		} as const;
		const track = vi.fn(async () => {});
		const client = new CodexAgentClient(connection, files.realpath, randomUUID, { track });
		const path = await files.realpath(root);
		await connection.initialize();
		// Codex requires HTTPS for discovered ChatGPT origins. Observe the signed-in
		// account request before that check to prove the synthetic token was loaded.
		await vi.waitFor(() => expect(accountAuthorization).toContain(`Bearer ${syntheticToken}`));
		const id = await client.start(path, provider);
		await client.send(
			id,
			path,
			"Run the fixture command.",
			{ permissions: "ask" },
			{ projectId: "fixture", phase: "chat" },
		);
		await vi.waitFor(
			() => expect(client.read(id).requests).toEqual([expect.objectContaining({ kind: "command" })]),
			{ timeout: 5000 },
		);
		client.reply(id, { requestId: client.read(id).requests.at(0)!.id, decision: "accept" });
		await vi.waitFor(() => expect(client.read(id).status).toBe("completed"), { timeout: 5000 });
		const autoId = await client.start(path, provider);
		const beforeAuto = requests.length;
		await expect(
			client.send(autoId, path, "Run the fixture command.", { permissions: "approve-for-me" }),
		).rejects.toMatchObject({ code: "unsupported-settings" });
		expect(requests).toHaveLength(beforeAuto);
		expect(
			requests.some(
				({ body }) => body.includes('"type":"function_call_output"') && body.includes("forge-provider-tool"),
			),
		).toBe(true);
		await connection.restart();
		expect((await client.resume(id, path, provider)).items).toContainEqual(
			expect.objectContaining({ text: "Fixture answer" }),
		);
		await client.send(
			id,
			path,
			"Plan a greeting.",
			{ permissions: "ask" },
			{
				projectId: "fixture",
				ticketId: "TASK-1",
				phase: "planning",
			},
		);
		await vi.waitFor(() => expect(client.read(id).status).toBe("completed"), { timeout: 5000 });
		expect(client.read(id).plan).toContain("# Greeting");
		await client.send(id, path, "Fail the fixture turn.", { permissions: "ask" });
		await vi.waitFor(() => expect(client.read(id).status).toBe("failed"), { timeout: 5000 });
		expect(track).not.toHaveBeenCalled();
		expect(requests.length).toBeGreaterThanOrEqual(2);
		for (const request of requests) {
			expect(request.url).toBe("/v1/responses");
			expect(request.headers).not.toHaveProperty("authorization");
			expect(request.headers).not.toHaveProperty("chatgpt-account-id");
			expect(JSON.stringify(request)).not.toContain(syntheticToken);
			expect(JSON.parse(request.body)).toMatchObject({ model: provider.model, stream: true });
		}
	} finally {
		await connection.close();
		server.closeAllConnections();
		await new Promise<void>((done) => server.close(() => done()));
		await files.rm(root, { recursive: true, force: true });
	}
}, 20000);
