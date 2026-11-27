import { start } from "./start.ts";

let close: (() => Promise<void>) | undefined;
let stopping = false;
const shutdown = async () => {
	if (stopping) return;
	stopping = true;
	await close?.();
};
try {
	const root = process.argv[2];
	if (!root || process.argv.length !== 3) throw new Error("Usage: forge-typescript-lsp <absolute-worktree>");
	close = await start(root, process.cwd());
	process.once("SIGTERM", () => {
		void shutdown();
	});
	process.once("SIGINT", () => {
		void shutdown();
	});
	process.stdin.once("end", () => {
		void shutdown();
	});
} catch {
	process.stderr.write("Forge TypeScript bridge failed: verify its worktree argument, cwd and installed runtime.\n");
	process.exitCode = 1;
	await shutdown();
}
