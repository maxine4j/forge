import { spawn } from "node:child_process";

import { writeFile } from "/app/packages/backend-infrastructure/dist/file.js";
const args = process.argv.slice(2);
if (args.includes("fetch")) {
	const child = spawn(
		process.execPath,
		["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],
		{ stdio: ["ignore", "pipe", "inherit"] },
	);
	child.stdout.once("data", async () => {
		await writeFile("/data/slow-git.json", JSON.stringify({ leader: process.pid, child: child.pid }));
	});
	process.on("SIGTERM", () => {});
	setInterval(() => {}, 1000);
} else {
	const child = spawn("git", args, { stdio: "inherit" });
	child.on("error", () => process.exit(1));
	child.on("exit", (code) => process.exit(code ?? 1));
}
