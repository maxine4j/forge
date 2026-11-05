import { once } from "node:events";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { mkdtemp, readFile, rm, writeFile } from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, it } from "vitest";

import { AccountAttemptStore } from "../../src/accounts/account-attempt-store.ts";
import { AccountProcess } from "../../src/accounts/account-process.ts";
import { AccountRouter } from "../../src/accounts/account-router.ts";
import { AccountService } from "../../src/accounts/account-service.ts";
import { CodexAccountClient } from "../../src/accounts/codex-account-client.ts";
import { CodexConnection } from "../../src/accounts/codex-connection.ts";
import { GithubAccountClient } from "../../src/accounts/github-account-client.ts";
import { AccessService } from "../../src/auth/access-service.ts";
import { SqliteDatabase } from "../../src/database/sqlite-database.ts";
import { HttpApplication } from "../../src/http/http-application.ts";

it("keeps HTTP health and sanitized account status usable when both CLIs are missing", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-missing-accounts-"));
	const database = new SqliteDatabase(join(directory, "forge.sqlite"));
	const processes = new AccountProcess(
		{
			dataDirectory: directory,
			path: process.env["PATH"] ?? "",
			codexExecutable: join(directory, "missing-codex"),
			githubExecutable: join(directory, "missing-gh"),
		},
		sleep,
	);
	const connection = new CodexConnection(processes, sleep);
	let github: GithubAccountClient | undefined;
	const server = createServer();
	try {
		await processes.initialize();
		await database.initialize();
		const attempts = new AccountAttemptStore(database);
		await attempts.initialize();
		github = new GithubAccountClient(processes, sleep, attempts);
		const access = new AccessService({ owner: "owner", origin: "https://forge.test" });
		const router = new AccountRouter(
			new AccountService(access, new CodexAccountClient(connection, attempts), github),
		);
		server.on("request", new HttpApplication(router, access).create().callback());
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("No listener");
		const base = `http://127.0.0.1:${address.port}`;
		const response = await fetch(`${base}/api/accounts`, { headers: { "x-webauth-user": "owner" } });
		expect(response.status).toBe(200);
		const status = await response.json();
		expect(status).toMatchObject({ codex: { connection: "unavailable" }, github: { connection: "unavailable" } });
		expect(JSON.stringify(status)).not.toContain(directory);
		expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: "up" });
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await github?.close();
		await connection.close();
		await database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

it("initializes actual pinned Codex stdio and reads an isolated unauthenticated account", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-real-codex-"));
	const database = new SqliteDatabase(join(directory, "forge.sqlite"));
	const processes = new AccountProcess(
		{
			dataDirectory: directory,
			path: process.env["PATH"] ?? "",
			codexExecutable: fileURLToPath(new URL("../../node_modules/.bin/codex", import.meta.url)),
			githubExecutable: "gh",
		},
		sleep,
	);
	const connection = new CodexConnection(processes, sleep);
	try {
		await processes.initialize();
		await database.initialize();
		const attempts = new AccountAttemptStore(database);
		await attempts.initialize();
		let version = "";
		const command = processes.spawn({
			program: "codex",
			arguments: ["--version"],
			onOutput: (chunk) => {
				version += chunk;
			},
			outputLimit: 4096,
		});
		expect(await command.done).toBe(0);
		expect(version.trim()).toBe("codex-cli 0.164.0");
		await connection.initialize();
		expect(await new CodexAccountClient(connection, attempts).status()).toEqual({
			connection: "available",
			login: { state: "idle" },
		});
	} finally {
		await connection.close();
		await database.close();
		await rm(directory, { recursive: true, force: true });
	}
});

it("uses real stdio peers for early notifications and gh prompt parsing, verification and cancellation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "forge-account-peers-"));
	const database = new SqliteDatabase(join(directory, "forge.sqlite"));
	const executable = join(directory, "account-peer");
	const processes = new AccountProcess(
		{
			dataDirectory: directory,
			path: process.env["PATH"] ?? "",
			codexExecutable: executable,
			githubExecutable: executable,
		},
		sleep,
	);
	const connection = new CodexConnection(processes, sleep);
	let github: GithubAccountClient | undefined;
	try {
		await writeFile(
			executable,
			`#!${process.execPath}\n${await readFile(fileURLToPath(new URL("../fixtures/account-peer.mjs", import.meta.url)))}`,
			{ mode: 0o700 },
		);
		await processes.initialize();
		await database.initialize();
		const attempts = new AccountAttemptStore(database);
		await attempts.initialize();
		const codex = new CodexAccountClient(connection, attempts);
		expect(await codex.start()).toMatchObject({ login: { state: "pending", userCode: "ABCD-EFGH" } });
		expect(await codex.status()).toMatchObject({
			account: { name: "owner@example.com" },
			login: { state: "completed" },
		});
		github = new GithubAccountClient(processes, sleep, attempts);
		expect(await github.start()).toMatchObject({
			login: { state: "pending", verificationUrl: "https://github.com/login/device", userCode: "GHGH-CODE" },
		});
		expect(await github.cancel()).toEqual({ connection: "available", login: { state: "cancelled" } });
		expect(await github.status()).toMatchObject({ account: { name: "owner" }, login: { state: "cancelled" } });
	} finally {
		await github?.close();
		await connection.close();
		await database.close();
		await rm(directory, { recursive: true, force: true });
	}
});
