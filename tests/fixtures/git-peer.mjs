import { spawn } from "node:child_process";

import { writeFile } from "@forge/backend-infrastructure/file";
const mode = process.argv.at(-2);
const path = process.argv.at(-1);
const child = spawn(
	process.execPath,
	["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"],
	{ stdio: ["ignore", "pipe", "inherit"] },
);
child.stdout.once("data", async () => {
	await writeFile(path, JSON.stringify({ leader: process.pid, child: child.pid }));
	if (mode === "exit") process.exit(0);
});
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
