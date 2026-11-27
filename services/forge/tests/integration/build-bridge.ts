import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const repository = resolve(dirname(new URL(import.meta.url).pathname), "..", "..");

export default function buildBridge(): void {
	const require = createRequire(import.meta.url);
	const packageFile = require.resolve("typescript/package.json");
	const tsc = resolve(
		dirname(packageFile),
		(JSON.parse(readFileSync(packageFile, "utf8")).bin as { tsc: string }).tsc,
	);
	execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
		cwd: repository,
		stdio: "inherit",
	});
}
