import { createInterface } from "node:readline";

const emit = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const command = process.argv[2];
if (command === "api") {
	process.stdout.write("HTTP/2.0 200 OK\r\n\r\n");
	emit({ login: "owner", extraSecret: "SECRET" });
} else if (command === "auth") {
	process.stderr.write("! First copy your one-time code: GHGH-CODE\n");
	process.stderr.write("Open this URL to continue in your web browser: https://github.com/login/device\n");
	process.stdin.resume();
} else if (command === "app-server") {
	let authenticated = false;
	createInterface({ input: process.stdin }).on("line", (line) => {
		const request = JSON.parse(line);
		if (request.method === "initialize")
			emit({
				id: request.id,
				result: {
					userAgent: "codex/0.164.0",
					codexHome: process.env.CODEX_HOME,
					platformFamily: "unix",
					platformOs: "linux",
				},
			});
		else if (request.method === "account/read")
			emit({
				id: request.id,
				result: {
					requiresOpenaiAuth: true,
					account: authenticated ? { type: "chatgpt", email: "owner@example.com", planType: "plus" } : null,
				},
			});
		else if (request.method === "account/login/start") {
			authenticated = true;
			emit({ method: "account/login/completed", params: { loginId: "attempt", success: true } });
			emit({ method: "account/updated", params: { authMode: "chatgpt", planType: "plus" } });
			emit({
				id: request.id,
				result: {
					type: "chatgptDeviceCode",
					loginId: "attempt",
					verificationUrl: "https://auth.openai.com/codex/device",
					userCode: "ABCD-EFGH",
				},
			});
		} else if (request.method === "account/login/cancel") emit({ id: request.id, result: { status: "canceled" } });
	});
} else {
	process.exitCode = 1;
}
