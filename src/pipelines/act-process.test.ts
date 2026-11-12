import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as files from "@forge/backend-infrastructure/file";
import { sleep } from "@forge/backend-infrastructure/sleep";
import { expect, test, vi } from "vitest";

import { ActProcess, actArguments } from "./act-process.ts";

test("argument arrays pin workflows and internal socket and disable automatic input files", () => {
	const args = actArguments(
		{ root: "/run", source: "/run/source", workflow: "/run/workflow.yml", payload: "/run/event.json" },
		{ branch: "main", workflowPath: ".github/workflows/ci.yml", event: "push" },
	);
	expect(args).toContain("--json");
	expect(args).toContain("--bind");
	expect(args).not.toContain("--verbose");
	expect(args).not.toContain("--no-skip-checkout");
	expect(args.filter((v) => v === "/dev/null")).toHaveLength(4);
	expect(args.join(" ")).toContain("--container-daemon-socket unix:///run/forge/docker.sock");
	expect(args.filter((v) => v.includes("=catthehacker/ubuntu@sha256:"))).toHaveLength(4);
});
test("consumes status after oversized output and retains only 10 MiB with curated environment", async () => {
	const root = await files.mkdtemp(join(tmpdir(), "forge-act-stream-"));
	try {
		const retained: Buffer[] = [];
		const adapter = new ActProcess(
			{ run: vi.fn() },
			{
				...files,
				writeFile: async (_path, data) => {
					retained.push(Buffer.from(data));
				},
			},
			sleep,
			process.env["PATH"] ?? "",
			process.execPath,
		);
		const records: string[] = [];
		const code = await adapter.run(
			{ root, source: root, workflow: join(root, "workflow.yml"), payload: join(root, "event.json") },
			{
				branch: "main",
				workflowPath: ".github/workflows/ci.yml",
				event: fileURLToPath(new URL("../../tests/fixtures/act-peer.mjs", import.meta.url)),
			},
			new AbortController().signal,
			(record) => records.push(record),
		);
		expect(code).toBe(0);
		expect(retained[0]?.length).toBe(10 * 1024 * 1024);
		expect(records).toHaveLength(1);
		expect(JSON.parse(records[0]!).stepResult).toBe("success");
	} finally {
		await files.rm(root, { recursive: true, force: true });
	}
});
test("cleanup removes only resources with this run's exact prefix", async () => {
	const id = "123e4567-e89b-42d3-a456-426614174000";
	const own = `act-forge-${id}-test`;
	const command = {
		run: vi.fn(async (args: string[]) =>
			args[1] === "ls" ? `${own}\nact-forge-other-test\nrepository\ncredentials` : "",
		),
	};
	const adapter = new ActProcess(
		command,
		{ writeFile: vi.fn(), readFile: vi.fn(), readdir: vi.fn().mockResolvedValue([]) },
		sleep,
		"",
	);
	await adapter.cleanup(id);
	expect(command.run.mock.calls.filter(([args]) => args[1] === "rm").map(([args]) => args.at(-1))).toEqual([
		own,
		own,
		own,
	]);
});
