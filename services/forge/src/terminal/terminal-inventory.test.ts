import { expect, it } from "vitest";

import { TerminalInventory } from "./terminal-inventory.ts";

it("fails closed for missing or malformed inventory", async () => {
	await expect(
		new TerminalInventory({ readdir: async () => [], readFile: async () => undefined }).identify(100),
	).rejects.toThrow("Invalid PTY session identity");
	await expect(
		new TerminalInventory({ readdir: async () => [], readFile: async () => "100 garbage" }).identify(100),
	).rejects.toThrow("Invalid process inventory");
});
it("reports a child without its own controlling terminal as pending", async () => {
	const inventory = new TerminalInventory({
		readdir: async () => [],
		readFile: async () => "100 (bash) S 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 7 0",
	});
	await expect(inventory.identify(100)).resolves.toBeUndefined();
});
it("uses Linux proc identity and ignores reused SID and unrelated sessions", async () => {
	const stat = (pid: number, group: number, session: number, start: number) =>
		`${pid} (command with ) spaces) S 1 ${group} ${session} 123 0 0 0 0 0 0 0 0 0 0 0 0 0 0 ${start} 0`;
	const entries = new Map([
		["/proc/100/stat", stat(100, 100, 100, 7)],
		["/proc/101/stat", stat(101, 101, 100, 8)],
		["/proc/999/stat", stat(999, 999, 999, 9)],
	]);
	const files = {
		readdir: async () => ["100", "101", "999", "self"],
		readFile: async (path: string) => entries.get(path),
	};
	const inventory = new TerminalInventory(files);
	const identity = { sessionId: 100, tty: 123, started: "7" };
	expect(await inventory.identify(100)).toEqual(identity);
	expect(await inventory.groups(identity)).toEqual(new Set([100, 101]));
	entries.set("/proc/100/stat", stat(100, 100, 100, 77));
	expect(await inventory.groups(identity)).toEqual(new Set());
});
