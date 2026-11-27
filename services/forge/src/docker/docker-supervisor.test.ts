import { expect, test, vi } from "vitest";

import { DockerSupervisor, type SupervisedProcess } from "./docker-supervisor.ts";

test("resets ephemeral state first; Docker failure leaves Forge alive; shutdown orders Forge before Docker", async () => {
	const calls: string[] = [];
	let dockerExit!: (code: number) => void;
	const process = (name: string): SupervisedProcess => ({
		done:
			name === "docker"
				? new Promise((resolve) => {
						dockerExit = resolve;
					})
				: new Promise(() => {}),
		stop: async (timeout) => {
			calls.push(`${name}:${timeout}`);
		},
	});
	const warn = vi.fn();
	const exit = vi.fn();
	const supervisor = new DockerSupervisor({
		reset: async () => {
			calls.push("reset");
		},
		docker: () => {
			calls.push("docker");
			return process("docker");
		},
		forge: () => {
			calls.push("forge");
			return process("forge");
		},
		warn,
	});
	await supervisor.start(exit);
	dockerExit(1);
	await Promise.resolve();
	expect(warn).toHaveBeenCalledOnce();
	expect(exit).not.toHaveBeenCalled();
	await supervisor.stop();
	expect(calls).toEqual(["reset", "docker", "forge", "forge:18000", "docker:7000"]);
});

test("Docker preparation failure still launches Forge; early shutdown prevents launching children", async () => {
	const forge = vi.fn(() => ({ done: new Promise<number>(() => {}), stop: async () => {} }));
	const runtime = {
		reset: async () => {
			throw new Error("read only");
		},
		docker: vi.fn(),
		forge,
		warn: vi.fn(),
	};
	const supervisor = new DockerSupervisor(runtime);
	await supervisor.start(vi.fn());
	expect(forge).toHaveBeenCalledOnce();
	await supervisor.stop();
	forge.mockClear();
	const early = new DockerSupervisor(runtime);
	await early.stop();
	await early.start(vi.fn());
	expect(forge).not.toHaveBeenCalled();
});
