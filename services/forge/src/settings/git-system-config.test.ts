import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as files from "@forge/backend-infrastructure/file";
import { expect, test } from "vitest";

import { GitSystemConfig } from "./git-system-config.ts";

test("system Git reads the published identity across homes, including escaped values and clearing", async () => {
	const directory = await files.mkdtemp(join(tmpdir(), "forge-git-system-"));
	try {
		const system = join(directory, "system.gitconfig");
		const included = join(directory, "identity.gitconfig");
		await files.writeFile(system, `[include]\n\tpath = "${included}"\n`);
		const git = new GitSystemConfig(included, files);
		const identity = { name: 'Forge "Dev" \\ Tools #1', email: "forge+dev@example.com" };
		const config = (home: string) =>
			execFileSync("git", ["config", "--list"], {
				cwd: directory,
				env: {
					PATH: process.env["PATH"],
					HOME: home,
					GIT_CONFIG_SYSTEM: system,
					GIT_CONFIG_GLOBAL: "/dev/null",
				},
				encoding: "utf8",
			});
		await git.publish(identity);
		for (const home of [directory, join(directory, "agent-home")]) {
			expect(config(home)).toContain(`user.name=${identity.name}\n`);
			expect(config(home)).toContain(`user.email=${identity.email}\n`);
		}
		expect((await files.stat(included)).mode & 0o777).toBe(0o644);
		await git.publish(undefined);
		expect(config(directory)).not.toMatch(/user\.(name|email)=/u);
	} finally {
		await files.rm(directory, { recursive: true, force: true });
	}
});
