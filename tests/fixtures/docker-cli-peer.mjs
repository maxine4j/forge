// Controlled process boundary for DockerCommand tests; never contacts a daemon.
const mode = process.argv[2];
if (mode === "hang")
	await new Promise(() => {
		setInterval(() => {}, 1000);
	});
else if (mode === "overflow") process.stdout.write("x".repeat(5 * 1024 * 1024));
else if (mode === "missing") {
	process.stderr.write("Error response from daemon: network disappeared not found\n");
	process.exitCode = 1;
} else if (mode === "failure") {
	process.stderr.write("sensitive diagnostics\n");
	process.exitCode = 1;
} else console.log(JSON.stringify({ args: process.argv.slice(3), env: process.env }));
